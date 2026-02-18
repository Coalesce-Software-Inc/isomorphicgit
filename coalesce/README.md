## Issues
1. This fork is not up to date with the source.  Due to drift and custom handling built into our fork, it's practically not feasible to reconcile our fork with the source.
	a. Custom merge conflict handling, the pattern for resolution, and extended cases handling for previously "Unhandlable Merge conflicts" that this package used to give up have been introduced to this fork.  Since then, a different merge conflict patter was built into the source, but we prefer our pattern. 
2. Builds are a bit messy.  Currently you must run the build commands (seen below) and commit the artifacts in order to affect the desired change in the consumer system of this repository.

## Making changes
1. Checkout the `coalesce-main` branch.
2. Create a named branch following standard Coalesce practice (includes story, task, bugfix, and the CD ticket id).
3. Make your changes to your working branch.
4. Execute the build command (below) and commit the artifacts and your changes.
5. To use that commit within the transform codebase:
	a. push your branch
	b. copy the commit sha including the build artifacts
	c. update the package.json entry for isomorphic-git and install dependencies
6. Iterate and when satisfied of the change, make a pull request from your branch back to `coalesce-main`

### Testing
Execute `npm test` to execute the full test suite.
Several remote executing tests are skipped as the current fork now lacks proper credentials, or due to unknown failures.
Our workflows are well tested within the Coalesce repository, so I'm okay with this.
- test-hosting-providers.js (Gitlab, Azure)
- test-commit.js (create signed commit)
- test-fetch.js (all, Request timeout issue)
- test-checkout.js (Remote fetching timeout issue)
- test-wire.js (parseRefsAdResponse HEAD bad space separated)

Run `npx jest -- path/to/file` to run an individual suite.
With the included skips, we expect all tests to be passing at this time.

## Build instructions
```
npm install --legacy-peer-deps
NODE_OPTIONS=--openssl-legacy-provider npm run build
```

Be aware that there will likely be a slew of warning messages.  They look bad, but you can ignore them.