import { GitPktLine } from '../models/GitPktLine.js'

/**
 * Builds a git-upload-pack request per the Git pack protocol v1.
 *
 * The upload-pack request is how a git client tells the server which objects
 * it needs. The request is a sequence of pkt-lines with this structure:
 *
 *   want <oid> <capabilities>\n   — objects the client wants (branch tips, tags)
 *   want <oid>\n                  — additional wants (no capabilities after first line)
 *   shallow <oid>\n               — shallow boundaries (see below)
 *   filter <spec>\n               — partial clone filter (see below)
 *   deepen <N>\n                  — depth limit / unshallow request (see below)
 *   deepen-since <timestamp>\n    — date-based depth limit
 *   deepen-not <ref>\n            — exclude commits reachable from ref
 *   flush-pkt                     — separator
 *   have <oid>\n                  — objects the client already has
 *   done\n                        — end of negotiation
 *
 * ## Shallow Clones & Boundaries
 *
 * A shallow clone (e.g. `depth: 3`) only fetches the last N commits. The
 * oldest commits in a shallow clone are called "shallow boundaries" — they
 * have parent pointers in their metadata, but those parents don't exist
 * locally. Git records these boundary OIDs in `.git/shallow`.
 *
 * Example with depth 3 on a branch A→B→C→D→E (E = HEAD):
 *
 *   Full history:    A → B → C → D → E
 *   Shallow clone:             C → D → E
 *                               ^
 *                          shallow boundary (recorded in .git/shallow)
 *
 * On subsequent fetches, the client MUST send `shallow <oid>` lines so the
 * server knows where the client's history ends. Without these, the server
 * assumes the client has full history and may send delta-compressed objects
 * referencing parents the client doesn't have.
 *
 * ## Unshallowing (Converting Shallow → Full Clone)
 *
 * To retrieve the full history that was previously excluded:
 *
 *   1. Client sends `shallow <oid>` lines as usual (tells server the boundaries)
 *   2. Client sends `deepen 2147483647` (INT32_MAX — effectively "give me everything")
 *   3. Server sends all missing history plus `unshallow <oid>` responses
 *   4. Client removes those OIDs from `.git/shallow` (via GitShallowManager)
 *
 * `unshallow` and `depth` are mutually exclusive — if you're requesting full
 * history, a specific depth limit would be contradictory.
 *
 * ## Partial Clone Filters
 *
 * The `filter` parameter (e.g. `blob:limit=2097152`) tells the server to
 * exclude certain objects from the packfile. The server omits matching objects
 * entirely — they won't exist in the local object store. This is independent
 * of shallow/depth and can be combined with either.
 *
 * @param {object} args
 * @param {string[]} args.capabilities - Protocol capabilities to advertise
 * @param {string[]} args.wants - OIDs of objects the client wants
 * @param {string[]} args.haves - OIDs of objects the client already has
 * @param {string[]} args.shallows - OIDs of current shallow boundary commits
 * @param {boolean} args.unshallow - If true, request full history (deepen INT32_MAX)
 * @param {string|null} args.filter - Partial clone filter spec (e.g. 'blob:limit=2097152')
 * @param {number|null} args.depth - Shallow clone depth limit
 * @param {Date|null} args.since - Date-based depth limit
 * @param {string[]} args.exclude - Refs whose reachable commits should be excluded
 * @returns {Array} Array of pkt-line encoded buffers
 */
export function writeUploadPackRequest({
  capabilities = [],
  wants = [],
  haves = [],
  shallows = [],
  unshallow = false,
  filter = null,
  depth = null,
  since = null,
  exclude = [],
}) {
  const packstream = []
  wants = [...new Set(wants)] // remove duplicates

  // First want line carries the capability advertisement
  let firstLineCapabilities = ` ${capabilities.join(' ')}`
  for (const oid of wants) {
    packstream.push(GitPktLine.encode(`want ${oid}${firstLineCapabilities}\n`))
    firstLineCapabilities = ''
  }

  // Always send shallow boundaries so the server knows where the client's
  // commit history ends. Required for both normal shallow fetches and unshallow.
  for (const oid of shallows) {
    packstream.push(GitPktLine.encode(`shallow ${oid}\n`))
  }

  // Partial clone: tell the server to exclude objects matching the filter spec
  if (filter !== null) {
    packstream.push(GitPktLine.encode(`filter ${filter}\n`))
  }

  // Depth negotiation: unshallow requests full history (INT32_MAX depth),
  // otherwise use the explicit depth if provided. These are mutually exclusive.
  if (unshallow) {
    packstream.push(GitPktLine.encode(`deepen 2147483647\n`))
  } else if (depth !== null) {
    packstream.push(GitPktLine.encode(`deepen ${depth}\n`))
  }

  if (since !== null) {
    packstream.push(
      GitPktLine.encode(`deepen-since ${Math.floor(since.valueOf() / 1000)}\n`)
    )
  }
  for (const oid of exclude) {
    packstream.push(GitPktLine.encode(`deepen-not ${oid}\n`))
  }

  // Flush separates the want/shallow/deepen section from the have section
  packstream.push(GitPktLine.flush())

  // Tell the server which objects we already have (for negotiation)
  for (const oid of haves) {
    packstream.push(GitPktLine.encode(`have ${oid}\n`))
  }
  packstream.push(GitPktLine.encode(`done\n`))
  return packstream
}
