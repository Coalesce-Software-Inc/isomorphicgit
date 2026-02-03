// @ts-check
import '../typedefs.js'

import { STAGE } from '../commands/STAGE.js'
import { TREE } from '../commands/TREE.js'
import { WORKDIR } from '../commands/WORKDIR.js'
import { _walk } from '../commands/walk.js'
import { _readTree } from "../commands/readTree.js"
import { CheckoutConflictError } from '../errors/CheckoutConflictError.js'
import { CommitNotFetchedError } from '../errors/CommitNotFetchedError.js'
import { InternalError } from '../errors/InternalError.js'
import { NotFoundError } from '../errors/NotFoundError.js'
import { GitConfigManager } from '../managers/GitConfigManager.js'
import { GitIndexManager } from '../managers/GitIndexManager.js'
import { GitRefManager } from '../managers/GitRefManager.js'
import { _readObject as readObject } from '../storage/readObject.js'
import { flat } from '../utils/flat.js'
import { worthWalking } from '../utils/worthWalking.js'

/**
 * @param {number} startMs
 */
const getElapsedSeconds = (startMs) => {
  return +((performance.now() - startMs) / 1000).toFixed(3);
}

/**
 * @param {object} args
 * @param {import('../models/FileSystem.js').FileSystem} args.fs
 * @param {any} args.cache
 * @param {ProgressCallback} [args.onProgress]
 * @param {string} args.dir
 * @param {string} args.gitdir
 * @param {string} args.ref
 * @param {string[]} [args.filepaths]
 * @param {string} args.remote
 * @param {boolean} args.noCheckout
 * @param {boolean} [args.noUpdateHead]
 * @param {boolean} [args.dryRun]
 * @param {boolean} [args.force]
 * @param {boolean} [args.track]
 *
 * @returns {Promise<object>} Resolves successfully when filesystem operations are complete
 *
 */
export async function _checkout({
  fs,
  cache,
  onProgress,
  dir,
  gitdir,
  remote,
  ref,
  filepaths,
  noCheckout,
  noUpdateHead,
  dryRun,
  force,
  track = true,
}) {
  const startTotal = performance.now();
  const perfSegments = {
    analyze: 0,
    conflicts: 0,
    createDirectories: 0,
    deleteDirectories: 0,
    deleteFiles: 0,
    errors: 0,
    resolveRemote: 0,
    updateHead: 0,
    writes: 0,
    total: 0,
  };

  // Get tree oid
  const startResolveRemote = performance.now();

  let oid
  try {
    console.log('[Git] checkout GitRefManager.resolve')
    oid = await GitRefManager.resolve({ fs, gitdir, ref })
    // TODO: Figure out what to do if both 'ref' and 'remote' are specified, ref already exists,
    // and is configured to track a different remote.
  } catch (err) {
    console.log('[Git] checkout ref: ', ref)
    console.log('[Git] checkout remote: ', remote)
    if (ref === 'HEAD') throw err
    // If `ref` doesn't exist, create a new remote tracking branch
    // Figure out the commit to checkout
    const remoteRef = `${remote}/${ref}`
    oid = await GitRefManager.resolve({
      fs,
      gitdir,
      ref: remoteRef,
    })
    console.log('[Git] checkout track', track)
    if (track) {
      // Set up remote tracking branch
      const config = await GitConfigManager.get({ fs, gitdir })
      await config.set(`branch.${ref}.remote`, remote)
      await config.set(`branch.${ref}.merge`, `refs/heads/${ref}`)
      await GitConfigManager.save({ fs, gitdir, config })
    }
    // Create a new branch that points at that same commit
    console.log('[Git] checkout writeRef')
    await GitRefManager.writeRef({
      fs,
      gitdir,
      ref: `refs/heads/${ref}`,
      value: oid,
    })
  }
  perfSegments.resolveRemote = getElapsedSeconds(startResolveRemote);

  // Update working dir
  console.log('[Git] checkout noCheckout: ', noCheckout)
  if (!noCheckout) {
    const startAnalyze = performance.now();

    let ops
    // First pass - just analyze files (not directories) and figure out what needs to be done
    try {
      if(onProgress) {
        await onProgress({ total: 0, phase: "pre-analyze", loaded: 0});
      }
      console.log('[Git] checkout analyze')
      ops = await analyze({
        fs,
        cache,
        onProgress,
        dir,
        gitdir,
        ref,
        force,
        filepaths,
      })
    } catch (err) {
      console.log('[Git] checkout analyze failed: ', err)
      // Throw a more helpful error message for this common mistake.
      if (err instanceof NotFoundError && err.data.what === oid) {
        throw new CommitNotFetchedError(ref, oid)
      } else {
        throw err
      }
    }
    if(onProgress) {
      await onProgress({ total: 0, phase: "post-analyze", loaded: 0});
    }
    perfSegments.analyze = getElapsedSeconds(startAnalyze);
  
    // Report conflicts
    const startConflicts = performance.now();

    const conflicts = ops
      .filter(([method]) => method === 'conflict')
      .map(([method, fullpath]) => fullpath)
    perfSegments.conflicts = getElapsedSeconds(startConflicts);

    if (conflicts.length > 0) {
      console.log('[Git] checkout has conflicts')
      throw new CheckoutConflictError(conflicts)
    }

    // Collect errors
    const startErrors = performance.now();

    const errors = ops
      .filter(([method]) => method === 'error')
      .map(([method, fullpath]) => fullpath)
    perfSegments.errors = getElapsedSeconds(startErrors);

    if (errors.length > 0) {
      console.log('[Git] checkout has errors')
      throw new InternalError(errors.join(', '))
    }

    console.log('[Git] checkout dryRun: ', dryRun)
    if (dryRun) {
      // Since the format of 'ops' is in flux, I really would rather folk besides myself not start relying on it
      // return ops
      perfSegments.total = getElapsedSeconds(startTotal);
      return perfSegments;
    }

    // Second pass - execute planned changes
    // The cheapest semi-parallel solution without computing a full dependency graph will be
    // to just do ops in 4 dumb phases: delete files, delete dirs, create dirs, write files

    let count = 0
    const total = ops.length
    //if we're going to do a majority of just pure file writes/updates, then lets read
    const startDeleteFiles = performance.now();

    await GitIndexManager.acquire({ fs, gitdir, cache }, async function(index) {
      //delete many only when fs has correct extra method
      if (fs._unlinkMany) {
        const deleteOps = ops.filter(([method])=> method === "delete").map(([method, fullpath]) => `${dir}/${fullpath}`);
        await fs.rmMany(deleteOps);
      }
      await Promise.all(
        ops
          .filter(
            ([method]) => method === 'delete' || method === 'delete-index'
          )
          .map(async function([method, fullpath]) {
            if (!fs._unlinkMany && method === 'delete') {	
              const filepath = `${dir}/${fullpath}`
              console.log('[Git] checkout rm file: ', filepath)
              await fs.rm(filepath)	
            }
            index.delete({ filepath: fullpath })
            if (onProgress) {
              await onProgress({
                phase: 'Updating workdir: rm',
                loaded: ++count,
                total,
              })
            }
          })
      )
    })
    perfSegments.deleteFiles = getElapsedSeconds(startDeleteFiles);

    // Note: this is cannot be done naively in parallel
    const startDeleteDirectories = performance.now();

    await GitIndexManager.acquire({ fs, gitdir, cache }, async function(index) {
      for (const [method, fullpath] of ops) {
        if (method === 'rmdir' || method === 'rmdir-index') {
          const filepath = `${dir}/${fullpath}`
          try {
            if (method === 'rmdir-index') {
              index.delete({ filepath: fullpath })
            }
            console.log('[Git] checkout rmdir: ', filepath)
            await fs.rmdir(filepath)
            if (onProgress) {
              await onProgress({
                phase: 'Updating workdir: rmdir',
                loaded: ++count,
                total,
              })
            }
          } catch (e) {
            if (e.code === 'ENOTEMPTY') {
              console.log(
                `Did not delete ${fullpath} because directory is not empty`
              )
            } else {
              throw e
            }
          }
        }
      }
    })
    perfSegments.deleteDirectories = getElapsedSeconds(startDeleteDirectories);

    const startCreateDirectories = performance.now();

    console.log('[Git] checkout mkdirs')
    await Promise.all(
      ops
        .filter(([method]) => method === 'mkdir' || method === 'mkdir-index')
        .map(async function([_, fullpath]) {
          const filepath = `${dir}/${fullpath}`
          console.log('[Git] checkout mkdir: ', filepath)
          await fs.mkdir(filepath)
          if (onProgress) {
            await onProgress({
              phase: 'Updating workdir: mkdir',
              loaded: ++count,
              total,
            })
          }
        })
    )
    perfSegments.createDirectories = getElapsedSeconds(startCreateDirectories);

    const startWrites = performance.now();

    console.log('[Git] checkout GitIndexManager.acquire write files')
    await GitIndexManager.acquire({ fs, gitdir, cache }, async function(index) {
      //only execute this enhanced performance methodology if our fs has the required internal functions, otherwise run the standard path
      if (fs._writeFiles && fs._unlinkMany) {
        const writeOps = ops.filter(([method]) => method === "create" || method === "update");
        const deletes = [];
        const modeWrites = [];
        const symlinkWrites = [];
        const regularWrites = [];
        for (const [_method, fullpath, oid, mode, chmod] of writeOps) {
          const filepath = `${dir}/${fullpath}`;
          if (chmod) {
            deletes.push(filepath);
          }
          console.log('[Git] checkout GitIndexManager.acquire write file: ', filepath)
          const { object } = await readObject({ fs, cache, gitdir, oid });
          if (!object) {
            console.log('[Git] checkout GitIndexManager.acquire object not found: ', oid)
            continue;
          }
          console.log('[Git] checkout GitIndexManager.acquire got object')
          const write = [filepath, object];
          if (mode === 0o100644) {
            regularWrites.push(write)
          } else if (mode === 0o100755) {
            modeWrites.push(write)
          } else if (mode === 0o120000) {
            symlinkWrites.push(write)
          } else {
            console.log('[Git] checkout invalid mode')
            throw new InternalError(
              `Invalid mode 0o${mode.toString(8)} detected in blob ${oid}`
            )
          }
        }

        console.log('[Git] checkout GitIndexManager.acquire rmMany')
        await fs.rmMany(deletes);
        if (onProgress) {
          await onProgress({ loaded: 0, total: 0, phase: "deleted files for chmod reasons"})
        }

        console.log('[Git] checkout fs.writeFiles')
        await fs.writeFiles(regularWrites, {});
        if (onProgress) {
          await onProgress({ loaded: 0, total: regularWrites.length, phase: "wrote regular files"})
        }
        await fs.writeFiles(modeWrites, { mode: 0o777 });
        if (onProgress) {
          await onProgress({ loaded: 0, total: modeWrites.length, phase: "wrote mode files"})
        }
        await Promise.all(symlinkWrites.map(([filepath, data]) => fs.writelink(filepath, data)));
        if (onProgress) {
          await onProgress({ loaded: 0, total: symlinkWrites.length, phase: "wrote symlink files"})
        }

      }

      console.log('[Git] checkout Promise.all write files')
      await Promise.all(
        ops
          .filter(
            ([method]) =>
              method === 'create' ||
              method === 'create-index' ||
              method === 'update' ||
              method === 'mkdir-index'
          )
          .map(async function([method, fullpath, oid, mode, chmod]) {
            const filepath = `${dir}/${fullpath}`
            try {
              if (!fs._writeFiles && method !== 'create-index' && method !== 'mkdir-index') {
                const { object } = await readObject({ fs, cache, gitdir, oid })
                if (!object) {
                  console.log('[Git] checkout Promise.all object not found: ', oid)
                  return
                }
                if (chmod) {
                  // Note: the mode option of fs.write only works when creating files,
                  // not updating them. Since the `fs` plugin doesn't expose `chmod` this
                  // is our only option.
                  await fs.rm(filepath)
                }
                if (mode === 0o100644) {
                  // regular file
                  console.log('[Git] checkout fs.write file')
                  await fs.write(filepath, object)
                } else if (mode === 0o100755) {
                  // executable file
                  await fs.write(filepath, object, { mode: 0o777 })
                } else if (mode === 0o120000) {
                  // symlink
                  await fs.writelink(filepath, object)
                } else {
                  console.log('[Git] checkout invalid mode')
                  throw new InternalError(
                    `Invalid mode 0o${mode.toString(8)} detected in blob ${oid}`
                  )
                }
              }
              const stats = await fs.lstat(filepath)
              // We can't trust the executable bit returned by lstat on Windows,
              // so we need to preserve this value from the TREE.
              // TODO: Figure out how git handles this internally.
              if (mode === 0o100755) {
                stats.mode = 0o755
              }
              // Submodules are present in the git index but use a unique mode different from trees
              if (method === 'mkdir-index') {
                stats.mode = 0o160000
              }
              index.insert({
                filepath: fullpath,
                stats,
                oid,
              })

              if (onProgress) {
                await onProgress({
                  phase: 'Updating workdir: write post',
                  loaded: ++count,
                  total,
                })
              }
            } catch (e) {
              console.log('[Git] checkout error', e)
              console.log(e)
            }
          })
      )
    })
    perfSegments.writes = getElapsedSeconds(startWrites);
  }

  // Update HEAD
  console.log('[Git] checkout noUpdatedHead: ', noUpdatedHead)
  if (!noUpdateHead) {
    const startUpdateHead = performance.now();

    const fullRef = await GitRefManager.expand({ fs, gitdir, ref })
    console.log('[Git] checkout fullRef: ', fullRef)
    if (fullRef.startsWith('refs/heads')) {
      await GitRefManager.writeSymbolicRef({
        fs,
        gitdir,
        ref: 'HEAD',
        value: fullRef,
      })
    } else {
      // detached head
      await GitRefManager.writeRef({ fs, gitdir, ref: 'HEAD', value: oid })
    }
    perfSegments.updateHead = getElapsedSeconds(startUpdateHead);
  }

  perfSegments.total = getElapsedSeconds(startTotal);
  return perfSegments;
}

async function readAllFiles({
  fs,
  gitdir,
  ref,
}) {
  const cache = {}
  const treeResult = await _readTree({ fs, gitdir, oid: ref, cache });
  return _walk({ fs, gitdir, cache, trees: [TREE({ref: treeResult.oid})], map: async (fileName, entries) => {
    const fileReadResult = { filePath: fileName, fileData: ""};
        //if there's content, use it, otherwise return an "empty" FileReadResult
        if (entries[0]) {
          const content = await entries[0].content();
          if (content && typeof content === "object") {
            fileReadResult.fileData = content;
          } else {
            fileReadResult.type = "Directory";
          }
        }
        return fileReadResult;
  }});
}


async function analyze({
  fs,
  cache,
  onProgress,
  dir,
  gitdir,
  ref,
  force,
  filepaths,
}) {
  let count = 0
  return _walk({
    fs,
    cache,
    dir,
    gitdir,
    trees: [TREE({ ref }), WORKDIR(), STAGE()],
    map: async function(fullpath, [commit, workdir, stage]) {
      if (fullpath === '.') return
      // match against base paths
      if (filepaths && !filepaths.some(base => worthWalking(fullpath, base))) {
        return null
      }
      // Emit progress event
      if (onProgress) {
        await onProgress({ phase: 'Analyzing workdir', loaded: ++count })
      }

      // This is a kind of silly pattern but it worked so well for me in the past
      // and it makes intuitively demonstrating exhaustiveness so *easy*.
      // This checks for the presense and/or absense of each of the 3 entries,
      // converts that to a 3-bit binary representation, and then handles
      // every possible combination (2^3 or 8 cases) with a lookup table.
      const key = [!!stage, !!commit, !!workdir].map(Number).join('')
      switch (key) {
        // Impossible case.
        case '000':
          return
        // Ignore workdir files that are not tracked and not part of the new commit.
        case '001':
          // OK, make an exception for explicitly named files.
          if (force && filepaths && filepaths.includes(fullpath)) {
            return ['delete', fullpath]
          }
          return
        // New entries
        case '010': {
          switch (await commit.type()) {
            case 'tree': {
              return ['mkdir', fullpath]
            }
            case 'blob': {
              return [
                'create',
                fullpath,
                await commit.oid(),
                await commit.mode(),
              ]
            }
            case 'commit': {
              return [
                'mkdir-index',
                fullpath,
                await commit.oid(),
                await commit.mode(),
              ]
            }
            default: {
              return [
                'error',
                `new entry Unhandled type ${await commit.type()}`,
              ]
            }
          }
        }
        // New entries but there is already something in the workdir there.
        case '011': {
          switch (`${await commit.type()}-${await workdir.type()}`) {
            case 'tree-tree': {
              return // noop
            }
            case 'tree-blob':
            case 'blob-tree': {
              return ['conflict', fullpath]
            }
            case 'blob-blob': {
              // Is the incoming file different?
              if ((await commit.oid()) !== (await workdir.oid())) {
                if (force) {
                  return [
                    'update',
                    fullpath,
                    await commit.oid(),
                    await commit.mode(),
                    (await commit.mode()) !== (await workdir.mode()),
                  ]
                } else {
                  return ['conflict', fullpath]
                }
              } else {
                // Is the incoming file a different mode?
                if ((await commit.mode()) !== (await workdir.mode())) {
                  if (force) {
                    return [
                      'update',
                      fullpath,
                      await commit.oid(),
                      await commit.mode(),
                      true,
                    ]
                  } else {
                    return ['conflict', fullpath]
                  }
                } else {
                  return [
                    'create-index',
                    fullpath,
                    await commit.oid(),
                    await commit.mode(),
                  ]
                }
              }
            }
            case 'commit-tree': {
              // TODO: submodule
              // We'll ignore submodule directories for now.
              // Users prefer we not throw an error for lack of submodule support.
              // gitlinks
              return
            }
            case 'commit-blob': {
              // TODO: submodule
              // But... we'll complain if there is a *file* where we would
              // put a submodule if we had submodule support.
              return ['conflict', fullpath]
            }
            default: {
              return ['error', `new entry Unhandled type ${commit.type}`]
            }
          }
        }
        // Something in stage but not in the commit OR the workdir.
        // Note: I verified this behavior against canonical git.
        case '100': {
          return ['delete-index', fullpath]
        }
        // Deleted entries
        // TODO: How to handle if stage type and workdir type mismatch?
        case '101': {
          switch (await stage.type()) {
            case 'tree': {
              return ['rmdir', fullpath]
            }
            case 'blob': {
              // Git checks that the workdir.oid === stage.oid before deleting file
              if ((await stage.oid()) !== (await workdir.oid())) {
                if (force) {
                  return ['delete', fullpath]
                } else {
                  return ['conflict', fullpath]
                }
              } else {
                return ['delete', fullpath]
              }
            }
            case 'commit': {
              return ['rmdir-index', fullpath]
            }
            default: {
              return [
                'error',
                `delete entry Unhandled type ${await stage.type()}`,
              ]
            }
          }
        }
        /* eslint-disable no-fallthrough */
        // File missing from workdir
        case '110':
        // Possibly modified entries
        case '111': {
          /* eslint-enable no-fallthrough */
          switch (`${await stage.type()}-${await commit.type()}`) {
            case 'tree-tree': {
              return
            }
            case 'blob-blob': {
              // If the file hasn't changed, there is no need to do anything.
              // Existing file modifications in the workdir can be be left as is.
              if (
                (await stage.oid()) === (await commit.oid()) &&
                (await stage.mode()) === (await commit.mode()) &&
                !force
              ) {
                return
              }

              // Check for local changes that would be lost
              if (workdir) {
                // Note: canonical git only compares with the stage. But we're smart enough
                // to compare to the stage AND the incoming commit.
                if (
                  (await workdir.oid()) !== (await stage.oid()) &&
                  (await workdir.oid()) !== (await commit.oid())
                ) {
                  if (force) {
                    return [
                      'update',
                      fullpath,
                      await commit.oid(),
                      await commit.mode(),
                      (await commit.mode()) !== (await workdir.mode()),
                    ]
                  } else {
                    return ['conflict', fullpath]
                  }
                }
              } else if (force) {
                return [
                  'update',
                  fullpath,
                  await commit.oid(),
                  await commit.mode(),
                  (await commit.mode()) !== (await stage.mode()),
                ]
              }
              // Has file mode changed?
              if ((await commit.mode()) !== (await stage.mode())) {
                return [
                  'update',
                  fullpath,
                  await commit.oid(),
                  await commit.mode(),
                  true,
                ]
              }
              // TODO: HANDLE SYMLINKS
              // Has the file content changed?
              if ((await commit.oid()) !== (await stage.oid())) {
                return [
                  'update',
                  fullpath,
                  await commit.oid(),
                  await commit.mode(),
                  false,
                ]
              } else {
                return
              }
            }
            case 'tree-blob': {
              return ['update-dir-to-blob', fullpath, await commit.oid()]
            }
            case 'blob-tree': {
              return ['update-blob-to-tree', fullpath]
            }
            case 'commit-commit': {
              return [
                'mkdir-index',
                fullpath,
                await commit.oid(),
                await commit.mode(),
              ]
            }
            default: {
              return [
                'error',
                `update entry Unhandled type ${await stage.type()}-${await commit.type()}`,
              ]
            }
          }
        }
      }
    },
    // Modify the default flat mapping
    reduce: async function(parent, children) {
      children = flat(children)
      if (!parent) {
        return children
      } else if (parent && parent[0] === 'rmdir') {
        children.push(parent)
        return children
      } else {
        children.unshift(parent)
        return children
      }
    },
  })
}
