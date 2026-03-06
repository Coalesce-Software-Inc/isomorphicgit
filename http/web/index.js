// Convert a value to an Async Iterator
// This will be easier with async generator functions.
function fromValue(value) {
  let queue = [value];
  return {
    next() {
      return Promise.resolve({ done: queue.length === 0, value: queue.pop() })
    },
    return() {
      queue = [];
      return {}
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

function getIterator(iterable) {
  if (iterable[Symbol.asyncIterator]) {
    return iterable[Symbol.asyncIterator]()
  }
  if (iterable[Symbol.iterator]) {
    return iterable[Symbol.iterator]()
  }
  if (iterable.next) {
    return iterable
  }
  return fromValue(iterable)
}

// Currently 'for await' upsets my linters.
async function forAwait(iterable, cb) {
  const iter = getIterator(iterable);
  while (true) {
    const { value, done } = await iter.next();
    if (value) await cb(value);
    if (done) break
  }
  if (iter.return) iter.return();
}

async function collect(iterable) {
  let size = 0;
  const buffers = [];
  // This will be easier once `for await ... of` loops are available.
  await forAwait(iterable, value => {
    buffers.push(value);
    size += value.byteLength;
  });
  const result = new Uint8Array(size);
  let nextIndex = 0;
  for (const buffer of buffers) {
    result.set(buffer, nextIndex);
    nextIndex += buffer.byteLength;
  }
  return result
}

// Convert a web ReadableStream (not Node stream!) to an Async Iterator
// adapted from https://jakearchibald.com/2017/async-iterators-and-generators/
function fromStream(stream) {
  // Use native async iteration if it's available.
  if (stream[Symbol.asyncIterator]) return stream
  const reader = stream.getReader();
  return {
    next() {
      return reader.read()
    },
    return() {
      reader.releaseLock();
      return {}
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/* eslint-env browser */

/**
 * HttpClient
 *
 * @param {GitHttpRequest} request
 * @returns {Promise<GitHttpResponse>}
 */
async function request({
  onProgress,
  url,
  method = 'GET',
  headers = {},
  body,
}) {
  // streaming uploads aren't possible yet in the browser
  if (body) {
    body = await collect(body);
  }
  const res = await fetch(url, { method, headers, body });
  const iter =
    res.body && res.body.getReader
      ? fromStream(res.body)
      : [new Uint8Array(await res.arrayBuffer())];
  // convert Header object to ordinary JSON
  headers = {};
  for (const [key, value] of res.headers.entries()) {
    headers[key] = value;
  }
  return {
    url: res.url,
    method: res.method,
    statusCode: res.status,
    statusMessage: res.statusText,
    body: iter,
    headers: headers,
  }
}

var index = { request };

export default index;
export { request };
