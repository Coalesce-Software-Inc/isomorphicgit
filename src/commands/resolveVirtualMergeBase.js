import { MergeNotSupportedError } from '../errors/MergeNotSupportedError.js';
import { EMPTY_TREE_OID } from '../utils/constants.js';
import { mergeTree } from '../utils/mergeTree.js';
import { _commit } from './commit.js';
import { _findMergeBase } from './findMergeBase.js';
/**
 * @param {object} args
 * @param {import('../models/FileSystem.js').FileSystem} args.fs
 * @param {any} args.cache
 * @param {string} args.gitdir
 * @param {string[]} args.oids
 * @param {number} args.depth
 * @param {number} args.maxDepth
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
 *
 */
export async function resolveVirtualMergeBase({fs, cache, gitdir, oids, depth, maxDepth, author, committer, signingKey, onSign }) {
    // During a merge, it's possible for two branches (commits) to have more than one merge base
    // in order to support merging them as git merge -s ort does, we will follow the same pattern as in that algorithm
    // When 2 common ancestors were identified by findMergeBase, we find their merge base and attempt to merge them together to create a stable base
    // When > 2 common ancestors, we must create a virtual tree by recursively to smush all the commits into one base object to proceed with the merge
    
    //if we've recursed the maximum amount of times or receive bad input, bail out
    if (depth > maxDepth || oids.length < 2) {
        throw new MergeNotSupportedError()
    } else if (oids.length === 2) {
        const baseOids = await _findMergeBase({fs, cache, gitdir, oids})
        if (baseOids.length < 1) {
            return EMPTY_TREE_OID;
        } else if (baseOids.length > 1) {
            //I don't think this should support that many recursive calls before a short circuit occurs
            //for perf reasons. I'd rather a customer just handle the merge off platform using real git.
            return await resolveVirtualMergeBase({ fs, cache, gitdir, oids: baseOids, maxDepth, depth: depth + 1, author, committer, signingKey, onSign })
        } else {
            //when it's one, then we're allowed to merge the two bases and report back to the caller so they can
            //continue with their merge
            const baseOid = baseOids[0];
            //if this throws bc of merge conflicts, we let it?
            return await mergeTree({ fs, cache, gitdir, ourOid: oids[0], theirOid: oids[1], baseOid })
            //do a merge of oids[0], oids[1] & baseOid, pass that sha back out

        }
    } else {
        //when >2 we have some work to do :grimmace:
        //virtual tree
        const virtualTree = await resolveVirtualMergeBase({ fs, cache, gitdir, oids: [oids[0], oids[1]], depth: depth + 1, maxDepth, author, committer, onSign, signingKey })
        const tempCommit = await _commit({
            fs, 
            cache, 
            gitdir,
            ref: oids[0],// use the 1st commit as 'our' ref for name purposes
            message: "virtual merge base commit", 
            tree: virtualTree, 
            parent: [oids[0], oids[1]],
            author,
            committer,
            onSign,
            signingKey
        });

        return await resolveVirtualMergeBase({ fs, cache, gitdir, oids: [tempCommit, ...oids.slice(2)], depth: depth + 1, maxDepth, author, committer, onSign, signingKey })
    }
}