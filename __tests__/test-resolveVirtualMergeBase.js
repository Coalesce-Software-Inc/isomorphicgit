/* eslint-env node, browser, jasmine */
const { Errors } = require("isomorphic-git")
import { resolveVirtualMergeBase } from "../src/commands/resolveVirtualMergeBase"
import * as commands from "../src/commands/commit";

const { makeFixture } = require('./__helpers__/FixtureFS.js')

// These have been checked with
// GIT_DIR=__tests__/__fixtures__/test-findMergeBase.git git merge-base -a --octopus COMMITS
describe('findMergeBase', () => {
  const author = {
        name: 'Mr. Test',
        email: 'mrtest@example.com',
        timestamp: 1262356920,
        timezoneOffset: -0,
      };
  //setup a fixture to merge two oids that do share a common base, allowing us to test that we can smush two commits together
  it('2 merge base scenario', async () => {
    // Setup test fixture.  had to create a test repo elsewhere, then cp the contents of the .git into this fixture dir for this case
    const { fs, gitdir } = await makeFixture('test-resolveVirtualMergeBase')
    // Test
    try {
      const base = await resolveVirtualMergeBase({
        fs, 
        gitdir,
        cache: {},
        author,
        committer: author,
        depth: 0, 
        maxDepth: 1, 
        oids: ['73cfbf17836344d1484bebade4b2fff89fca6646', '8ecea0881c67a7603105941d321d723ff44827aa']
      })
      expect(base).toBeDefined();
    } catch(error) {
      console.error("Error: ", error);
      throw new Error("Failed merge base scenario")
    }
  })

  it('3 oid merge base scenario', async () => {
    // Setup test fixture.  had to create a test repo elsewhere, then cp the contents of the .git into this fixture dir for this case
    const { fs, gitdir } = await makeFixture('test-resolveVirtualMergeBase')
    // Test
    try {
      const _commitSpy = jest.spyOn(commands, "_commit");
      const base = await resolveVirtualMergeBase({
        fs, 
        gitdir,
        cache: {},
        author,
        committer: author,
        depth: 0, 
        maxDepth: 1, 
        oids: ['73cfbf17836344d1484bebade4b2fff89fca6646', '8ecea0881c67a7603105941d321d723ff44827aa', 'ce0491f81d303d3f5424f66a760a6f1835b6baa8'] //Z1, Z2, main commits
      })
      expect(base).toBeDefined();
      //confirm that we called _commit, validating we hit the 3 branch of the func
      expect(_commitSpy).toHaveBeenCalled();
    } catch(error) {
      console.error("Error: ", error);
      throw new Error("Failed merge base scenario")
    }
  })

  it('should throw if oids contains less than 2 commits', async () => {
    // Setup
    const { fs, gitdir } = await makeFixture('test-findMergeBase')
    // Test
    let err;
    try {
      await resolveVirtualMergeBase({
        fs, 
        gitdir, 
        cache: {},
        author,
        committer: author,
        depth: 0, 
        maxDepth: 1, 
        oids: ['17aa7af08369d0e2d174df64d78fe57f9f0a60ba']
      })
    } catch(e){
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe(Errors.MergeNotSupportedError.code)
  })

  it('should throw if maxDepth has been exceeded', async () => {
    // Setup
    const { fs, gitdir } = await makeFixture('test-findMergeBase')
    // Test
    let err;
    try {
      await resolveVirtualMergeBase({
        fs, 
        gitdir,
        cache: {},
        author,
        committer: author,
        depth: 2, 
        maxDepth: 1, 
        oids: ['17aa7af08369d0e2d174df64d78fe57f9f0a60ba', '17b2c7d8ba9756c6c28e4d8cfdbed11793952270']
      });
    } catch(e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe(Errors.MergeNotSupportedError.code)
    
  })

  it('should return the empty tree sha if no base ancestor is found', async () => {
    // Setup
    const { fs, gitdir } = await makeFixture('test-findMergeBase')
    // Test
    const oid = await resolveVirtualMergeBase({
      fs, 
      gitdir,
      cache: {},
      author,
      committer: author, 
      depth: 0, 
      maxDepth: 2, 
      oids: ['9ec6646dd454e8f530c478c26f8b06e57f880bd6', '99cfd5bb4e412234162ac1eb46350ec6ccffb50d']
    });
    expect(oid).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
  })
})
