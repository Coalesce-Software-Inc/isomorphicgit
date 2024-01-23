// @ts-check
import '../typedefs.js'

import { TREE } from '../commands/TREE.js'
import { _walk } from '../commands/walk.js'
import { MergeNotSupportedError } from '../errors/MergeNotSupportedError.js'
import { GitTree } from '../models/GitTree.js'
import { _writeObject as writeObject } from '../storage/writeObject.js'

import { basename } from './basename.js'
import { join } from './join.js'
import { mergeFile } from './mergeFile.js'
import { MergeAbortedError } from '../errors/MergeAbortedError.js'

/**
 * Create a merged tree
 *
 * @param {Object} args
 * @param {import('../models/FileSystem.js').FileSystem} args.fs
 * @param {object} args.cache
 * @param {string} [args.dir] - The [working tree](dir-vs-gitdir.md) directory path
 * @param {string} [args.gitdir=join(dir,'.git')] - [required] The [git directory](dir-vs-gitdir.md) path
 * @param {string} args.ourOid - The SHA-1 object id of our tree
 * @param {string} args.baseOid - The SHA-1 object id of the base tree
 * @param {string} args.theirOid - The SHA-1 object id of their tree
 * @param {string} [args.ourName='ours'] - The name to use in conflicted files for our hunks
 * @param {string} [args.baseName='base'] - The name to use in conflicted files (in diff3 format) for the base hunks
 * @param {string} [args.theirName='theirs'] - The name to use in conflicted files for their hunks
 * @param {boolean} [args.dryRun=false]
 * @param {function} [args.asyncMergeConflictCallback] - The function to allow for async user resolution of conflicts
 * @param {function} [args.iterateOverride] - overwrite the default iterate functionality for mergeTree
 * @returns {Promise<string>} - The SHA-1 object id of the merged tree
 *
 */
export async function mergeTree({
  fs,
  cache,
  dir,
  gitdir = join(dir, '.git'),
  ourOid,
  baseOid,
  theirOid,
  ourName = 'ours',
  baseName = 'base',
  theirName = 'theirs',
  dryRun = false,
  asyncMergeConflictCallback,
  iterateOverride,
}) {
  const ourTree = TREE({ ref: ourOid })
  const baseTree = TREE({ ref: baseOid })
  const theirTree = TREE({ ref: theirOid })

  const results = await _walk({
    fs,
    cache,
    dir,
    gitdir,
    iterate: iterateOverride,
    trees: [ourTree, baseTree, theirTree],
    map: async function(filepath, [ours, base, theirs]) {
      const path = basename(filepath)
      // What we did, what they did
      const ourChange = await modified(ours, base)
      const theirChange = await modified(theirs, base)
      switch (`${ourChange}-${theirChange}`) {
        case 'false-false': {
          return {
            mode: await base.mode(),
            path,
            oid: await base.oid(),
            type: await base.type(),
          }
        }
        case 'false-true': {
          return theirs
            ? {
                mode: await theirs.mode(),
                path,
                oid: await theirs.oid(),
                type: await theirs.type(),
              }
            : undefined
        }
        case 'true-false': {
          return ours
            ? {
                mode: await ours.mode(),
                path,
                oid: await ours.oid(),
                type: await ours.type(),
              }
            : undefined
        }
        case 'true-true': {
          // Base case, no alterations except for just passing through the asyncMergeConflictCallback in the event it's not a clean merge
          if (
            ours &&
            base &&
            theirs &&
            (await ours.type()) === 'blob' &&
            (await base.type()) === 'blob' &&
            (await theirs.type()) === 'blob'
          ) {
            return mergeBlobs({
              fs,
              gitdir,
              path,
              ours,
              base,
              theirs,
              ourName,
              baseName,
              theirName,
              asyncMergeConflictCallback,
            })
          }
          // case: base doesn't have the file, was added in both ours and theirs
          else if (
            base === null && 
            (await ours.type()) === 'blob' &&
            (await theirs.type()) === 'blob'
          ) {
            return mergeBlobs({
              fs,
              gitdir,
              path,
              ours,
              base,
              theirs,
              ourName,
              theirName,
              asyncMergeConflictCallback,
            })
          }
          //case: this happens when both repos introduce a new directory
          else if (base === null && (await ours.type()) === 'tree' && (await theirs.type()) === 'tree') {
            //if we have ours, then use ours to introduce the directory, since it's a directory this doesn't matter where it actually comes from
            return ours
            ? {
                mode: await ours.mode(),
                path,
                oid: await ours.oid(),
                type: await ours.type(),
              }
            : undefined
          }
          //case: deleted in both, but was in base
            else if (base !== null && !ours && !theirs) {
              //returning undefined prunes the file/directory, since it was deleted in both, that's what we want
            return undefined;
          }
          //case: base has file, we made change with file, theirs was delete
          else if (base !== null && !!ours && !theirs && (await ours.type()) === 'blob') {
            //let the user decide using the conflict resolution tool
            return mergeBlobs({
              fs,
              gitdir,
              path,
              ours,
              base,
              theirs,
              ourName,
              theirName,
              asyncMergeConflictCallback,
            })
          }

          //case: base has file, we delete file, theirs was change
          else if (base !== null && !!theirs && !ours && (await theirs.type()) === 'blob') {
            return mergeBlobs({
              fs,
              gitdir,
              path,
              ours,
              base,
              theirs,
              ourName,
              theirName,
              asyncMergeConflictCallback,
            })
          }
          
          //not really sure what's not covered by above, but this is a fallback
          throw new MergeNotSupportedError()
        }
        default: {
          //case: we should never land here
          throw new MergeNotSupportedError()
        }
      }
    },
    /**
     * @param {TreeEntry} [parent]
     * @param {Array<TreeEntry>} children
     */
    reduce: async (parent, children) => {
      const entries = children.filter(Boolean) // remove undefineds

      // if the parent was deleted, the children have to go
      if (!parent) return

      // automatically delete directories if they have been emptied
      if (parent && parent.type === 'tree' && entries.length === 0) return

      if (entries.length > 0) {
        const tree = new GitTree(entries)
        const object = tree.toObject()
        const oid = await writeObject({
          fs,
          gitdir,
          type: 'tree',
          object,
          dryRun,
        })
        parent.oid = oid
      }
      return parent
    },
  })
  return results.oid
}

/**
 *
 * @param {WalkerEntry} entry
 * @param {WalkerEntry} base
 *
 */
async function modified(entry, base) {
  if (!entry && !base) return false
  if (entry && !base) return true
  if (!entry && base) return true
  if ((await entry.type()) === 'tree' && (await base.type()) === 'tree') {
    return false
  }
  if (
    (await entry.type()) === (await base.type()) &&
    (await entry.mode()) === (await base.mode()) &&
    (await entry.oid()) === (await base.oid())
  ) {
    return false
  }
  return true
}

/**
 *
 * @param {Object} args
 * @param {import('../models/FileSystem').FileSystem} args.fs
 * @param {string} args.gitdir
 * @param {string} args.path
 * @param {WalkerEntry} args.ours
 * @param {WalkerEntry} args.base
 * @param {WalkerEntry} args.theirs
 * @param {string} [args.ourName]
 * @param {string} [args.baseName]
 * @param {string} [args.theirName]
 * @param {string} [args.format]
 * @param {number} [args.markerSize]
 * @param {boolean} [args.dryRun = false]
 * @param {function} [args.asyncMergeConflictCallback]
 *
 */
async function mergeBlobs({
  fs,
  gitdir,
  path,
  ours,
  base,
  theirs,
  ourName,
  theirName,
  baseName,
  format,
  markerSize,
  dryRun,
  asyncMergeConflictCallback,
}) {
  //if ours or theirs is null (not typically handled, but now I'm adding support for it maybe?)
  //let the user provide a mergeText, if it's empty string, then we want to delete so return undefined
  //if not undefined then we writeObject as before.
  const type = 'blob'
  // Compute the new mode.
  // Since there are ONLY two valid blob modes ('100755' and '100644') it boils down to this
  let ourMode = !!ours ? await ours.mode() : null;
  let theirMode = !!theirs ? await theirs.mode() : null;
  let baseMode = !!base ? await base.mode() : null;
  if (!!baseMode && !!ourMode && !!theirMode) {
    const mode = baseMode === ourMode ? theirMode : ourMode;
    const baseOID = await base.oid();
    const oursOID = await ours.oid();
    const theirsOID = await theirs.oid();
    // The trivial case: nothing to merge except maybe mode
    if (oursOID === theirsOID) {
      return { mode, path, oid: oursOID, type }
    }
    // if only one side made oid changes, return that side's oid
    if (oursOID === baseOID) {
      return { mode, path, oid: await theirsOID, type }
    }
    if (theirsOID === baseOID) {
      return { mode, path, oid: await oursOID, type }
    }
  }
  // if both sides made changes do a merge
  let baseContent = "";
  let ourContent = "";
  let theirContent = "";
  try {
    baseContent = Buffer.from(await base.content()).toString('utf8');
  } catch {
  }

  try {
    ourContent = Buffer.from(await ours.content()).toString('utf8');
  } catch {
  }

  try {
    theirContent = Buffer.from(await theirs.content()).toString('utf8');
  } catch {
  }
  const { mergedText, cleanMerge } = mergeFile({
    ourContent,
    baseContent,
    theirContent,
    ourName,
    theirName,
    baseName,
    format,
    markerSize,
  })

  let awaitedMergedText = mergedText
  if (!cleanMerge) {
    // all other types of conflicts fail
    try {
      let fullpath = ""
      try {
        //possibly null
        fullpath = base._fullpath
      }catch(error) {
        //get the path
        fullpath = ours?._fullpath || theirs._fullpath
      }
      awaitedMergedText = await asyncMergeConflictCallback(mergedText, fullpath);
      //the user deleted all the text, we remove the file
      if (!awaitedMergedText) {
        return undefined;
      }
    } catch (error) {
      if (error?.message === "Aborted merge") {
        throw new MergeAbortedError()
      } else {
        throw new MergeNotSupportedError()
      }
    }
  }

  const oid = await writeObject({
    fs,
    gitdir,
    type: 'blob',
    object: Buffer.from(awaitedMergedText, 'utf8'),
    dryRun,
  })
  return { mode:ourMode ?? theirMode, path, oid, type }
}
