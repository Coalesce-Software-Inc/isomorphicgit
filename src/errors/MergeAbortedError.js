import { BaseError } from "./BaseError"

export class MergeAbortedError extends BaseError {
    constructor() {
        super(`The merge process was intentionally aborted.`)
        this.code = this.name
        this.data = {}
    }
}

/** @type {'MergeAbortedError'} */
MergeNotSupportedError.code = 'MergeAbortedError'