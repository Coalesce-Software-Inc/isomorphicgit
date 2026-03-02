// @ts-check
import '../typedefs.js'

import { _commit } from '../commands/commit'
import { _currentBranch } from '../commands/currentBranch.js'
import { _findMergeBase } from '../commands/findMergeBase.js'
import { FastForwardError } from '../errors/FastForwardError.js'
import { GitRefManager } from '../managers/GitRefManager.js'
import { abbreviateRef } from '../utils/abbreviateRef.js'
import { EMPTY_TREE_OID } from '../utils/constants.js'
import { mergeTree } from '../utils/mergeTree.js'
import { resolveVirtualMergeBase } from './resolveVirtualMergeBase.js'

/**
 *
 * @typedef {Object} MergeResult - Returns an object with a schema like this:
 * @property {string} [oid] - The SHA-1 object id that is now at the head of the branch. Absent only if `dryRun` was specified and `mergeCommit` is true.
 * @property {boolean} [alreadyMerged] - True if the branch was already merged so no changes were made
 * @property {boolean} [fastForward] - True if it was a fast-forward merge
 * @property {boolean} [mergeCommit] - True if merge resulted in a merge commit
 * @property {string} [tree] - The SHA-1 object id of the tree resulting from a merge commit
 *
 */

/**
 * @param {object} args
 * @param {import('../models/FileSystem.js').FileSystem} args.fs
 * @param {object} args.cache
 * @param {string} args.gitdir
 * @param {string} [args.ours]
 * @param {string} args.theirs
 * @param {boolean} args.fastForwardOnly
 * @param {boolean} args.dryRun
 * @param {boolean} args.noUpdateBranch
 * @param {string} [args.message]
 * @param {Object} args.author
 * @param {string} args.author.name
 * @param {string} args.author.email
 * @param {number} args.author.timestamp
 * @param {number} args.author.timezoneOffset
 * @param {Object} args.committer
 * @param {string} args.committer.name
 * @param {string} args.committer.email
 * @param {number} args.committer.timestamp
 * @param {number} args.committer.timezoneOffset
 * @param {string} [args.signingKey]
 * @param {SignCallback} [args.onSign] - a PGP signing implementation
 * @param {function} [args.asyncMergeConflictCallback]
 * @param {function} [args.iterateOverride]
 *
 * @returns {Promise<MergeResult>} Resolves to a description of the merge operation
 *
 */
export async function _merge({
  fs,
  cache,
  gitdir,
  ours,
  theirs,
  fastForwardOnly = false,
  dryRun = false,
  noUpdateBranch = false,
  message,
  author,
  committer,
  signingKey,
  onSign,
  asyncMergeConflictCallback,
  iterateOverride,
}) {
  if (ours === undefined) {
    ours = await _currentBranch({ fs, gitdir, fullname: true })
  }
  ours = await GitRefManager.expand({
    fs,
    gitdir,
    ref: ours,
  })
  theirs = await GitRefManager.expand({
    fs,
    gitdir,
    ref: theirs,
  })
  const ourOid = await GitRefManager.resolve({
    fs,
    gitdir,
    ref: ours,
  })
  const theirOid = await GitRefManager.resolve({
    fs,
    gitdir,
    ref: theirs,
  })
  // find most recent common ancestor of ref a and ref b
  const baseOids = await _findMergeBase({
    fs,
    cache,
    gitdir,
    oids: [ourOid, theirOid],
  })

  let baseOid;
  if (baseOids.length < 1) {
    //in the event that there is no common commit ancestor for two branches in a repo (wild)
    //use the empty tree reference
    baseOid = EMPTY_TREE_OID;
  } else if (baseOids.length > 1) {
    // find the best option of the multiple ancestors
    //allegedly real git would create a virtual tree by merging the oids together
    //to form a virtual tree to use as the base for the 3way diff merge later on
    baseOid = await resolveVirtualMergeBase({ fs, cache, gitdir, oids: baseOids, maxDepth: 5, depth: 0, author, committer, signingKey, onSign })
  } else {
    baseOid = baseOids[0]
  }
  
  // handle fast-forward case
  if (baseOid === theirOid) {
    return {
      oid: ourOid,
      alreadyMerged: true,
    }
  }
  if (baseOid === ourOid) {
    if (!dryRun && !noUpdateBranch) {
      await GitRefManager.writeRef({ fs, gitdir, ref: ours, value: theirOid })
    }
    return {
      oid: theirOid,
      fastForward: true,
    }
  } else {
    // not a simple fast-forward
    if (fastForwardOnly) {
      throw new FastForwardError()
    }
      // try a fancier merge
    const tree = await mergeTree({
      fs,
      cache,
      gitdir,
      ourOid,
      theirOid,
      baseOid,
      ourName: ours,
      baseName: 'base',
      theirName: theirs,
      dryRun,
      asyncMergeConflictCallback,
      iterateOverride,
    })
    if (!message) {
      message = `Merge branch '${abbreviateRef(theirs)}' into ${abbreviateRef(
        ours
      )}`
    }
    const oid = await _commit({
      fs,
      cache,
      gitdir,
      message,
      ref: ours,
      tree,
      parent: [ourOid, theirOid],
      author,
      committer,
      signingKey,
      onSign,
      dryRun,
      noUpdateBranch,
    })
    return {
      oid,
      tree,
      mergeCommit: true,
    }

    }
}
