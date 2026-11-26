import {
  checkPng,
  ComputerUseError,
  isObject,
  type JsonObject,
  JSON_LIMIT,
  PNG_LIMIT,
  screenshotFor,
} from "./protocol.js";

const HEADER_BYTES = 8;
const EMPTY = Buffer.alloc(0);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function checkLengths(json: number, binary: number): void {
  if (json === 0 || json > JSON_LIMIT || binary > PNG_LIMIT) {
    throw new ComputerUseError("frame_limit");
  }
}

export function encodeFrame(message: JsonObject, binary: Buffer = EMPTY): Buffer {
  if (!isObject(message)) throw new ComputerUseError("invalid_frame");
  const json = Buffer.from(JSON.stringify(message));
  checkLengths(json.length, binary.length);
  const screenshot = screenshotFor(message, binary.length);
  if (screenshot) checkPng(binary, screenshot);
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(json.length, 0);
  header.writeUInt32BE(binary.length, 4);
  return Buffer.concat([header, json, binary]);
}

function decodeJson(bytes: Buffer): JsonObject {
  let message: unknown;
  try {
    message = JSON.parse(utf8.decode(bytes));
  } catch (cause) {
    throw new ComputerUseError("invalid_frame", { cause });
  }
  if (!isObject(message)) throw new ComputerUseError("invalid_frame");
  return message;
}

/** Validates metadata before allocating or reading the optional PNG. */
export class FrameDecoder {
  #header = Buffer.allocUnsafe(HEADER_BYTES);
  #part: Buffer = this.#header;
  #offset = 0;
  #read: (bytes: Buffer) => void = this.#readHeader;
  #failure?: ComputerUseError;

  constructor(
    private readonly receiveMetadata: (message: JsonObject) => (binary: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.#failure) throw this.#failure;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const size = Math.min(this.#part.length - this.#offset, chunk.length - offset);
        chunk.copy(this.#part, this.#offset, offset, offset + size);
        offset += size;
        this.#offset += size;
        if (this.#offset === this.#part.length) this.#read(this.#part);
      }
    } catch (cause) {
      this.#failure =
        cause instanceof ComputerUseError
          ? cause
          : new ComputerUseError("invalid_frame", { cause });
      throw this.#failure;
    }
  }

  finish(): void {
    if (this.#failure) throw this.#failure;
    if (this.#part !== this.#header || this.#offset !== 0) {
      this.#failure = new ComputerUseError("invalid_frame");
      throw this.#failure;
    }
  }

  #next(part: Buffer, read: (bytes: Buffer) => void): void {
    this.#part = part;
    this.#offset = 0;
    this.#read = read;
  }

  #readHeader(header: Buffer): void {
    const jsonLength = header.readUInt32BE(0);
    const binaryLength = header.readUInt32BE(4);
    checkLengths(jsonLength, binaryLength);
    this.#next(Buffer.allocUnsafe(jsonLength), (json) => {
      const message = decodeJson(json);
      const screenshot = screenshotFor(message, binaryLength);
      const receive = this.receiveMetadata(message);
      if (!screenshot) {
        this.#next(this.#header, this.#readHeader);
        receive(EMPTY);
        return;
      }
      this.#next(Buffer.allocUnsafe(binaryLength), (binary) => {
        checkPng(binary, screenshot);
        this.#next(this.#header, this.#readHeader);
        receive(binary);
      });
    });
  }
}
