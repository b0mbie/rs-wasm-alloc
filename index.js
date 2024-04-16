// WebAssembly external allocator.

"use strict";

class Runner extends EventTarget {
	constructor() {
		super();
		this.textDecoder = new TextDecoder();
		this.textEncoder = new TextEncoder();
	}

	/**
	 * @param {WebAssembly.Module} module
	 * @param {WebAssembly.Instance} instance
	 */
	instantiate(module, instance) {
		this.module = module;
		this.instance = instance;
	}

	/**
	 * @param {integer} funcId
	 * @returns {Function}
	 */
	getFunction(funcId) {
		const funcTable = this.instance.exports["__indirect_function_table"];
		if (funcTable === undefined) {
			throw new FatalError("indirect function table is not exported");
		}

		const func = funcTable.get(funcId);
		if (func === undefined) {
			throw new FatalError(`function #${funcId} is invalid`);
		}

		return func;
	}

	getExportedFunction(name) {
		return this.instance.exports[name];
	}

	memory() {
		const memory = this.instance.exports.memory;
		if (memory === undefined) {
			throw new FatalError("memory is not exported");
		}
		return memory;
	}

	writeU8(offset, value){
		(new Uint8Array(this.memory().buffer, offset, 1))[0] = value;
	}

	readU8(offset) {
		return (new Uint8Array(this.memory().buffer, offset, 1))[0];
	}

	writeI32(offset, value) {
		(new Int32Array(this.memory().buffer, offset, 1))[0] = value;
	}

	readI32(offset) {
		return (new Int32Array(this.memory().buffer, offset, 1))[0];
	}

	writeU32(offset, value) {
		(new Uint32Array(this.memory().buffer, offset, 1))[0] = value;
	}

	readU32(offset) {
		return (new Uint32Array(this.memory().buffer, offset, 1))[0];
	}

	writeF32(offset, value) {
		(new Float32Array(this.memory().buffer, offset, 1))[0] = value;
	}

	readF32(offset) {
		return (new Float32Array(this.memory().buffer, offset, 1))[0];
	}

	bytes(offset, length) {
		return new Uint8Array(this.memory().buffer, offset, length);
	}

	decodeUtf8(pointer, length) {
		return this.textDecoder.decode(
			new Uint8Array(this.memory().buffer, pointer, length)
		);
	}

	encodeUtf8(pointer, length, data) {
		return this.textEncoder.encodeInto(
			data,
			new Uint8Array(this.memory().buffer, pointer, length)
		);
	}
}

class WasmPanicError extends Error {
	constructor(message, file, line, column) {
		super(message);
		this.file = file;
		this.line = line;
		this.column = column;
	}
}

class FreeUnallocedError extends Error {
	/**
	 * @param {number} pointer
	 * @param {number} size
	 * @param {number} align
	 */
	constructor(pointer, size, align) {
		super(
			`tried to free unallocated memory ` +
			`(of size ${size} with alignment ${align}) ` +
			`at 0x${pointer.toString(16)}`
		);
		this.pointer = pointer;
		this.size = size;
		this.align = align;
	}
}

class FreeAgainError extends Error {
	/**
	 * @param {number} pointer
	 * @param {number} size
	 * @param {number} align
	 */
	constructor(pointer, size, align) {
		super(
			`tried to free again memory ` +
			`(of size ${size} with alignment ${align}) ` +
			`at 0x${pointer.toString(16)}`
		);
		this.pointer = pointer;
		this.size = size;
		this.align = align;
	}
}

class FreeMismatchedSizeError extends Error {
	/**
	 * @param {number} pointer
	 * @param {number} triedSize
	 * @param {number} triedAlign
	 * @param {number} actualSize
	 */
	constructor(pointer, triedSize, triedAlign, actualSize) {
		super(
			`tried to free memory with mismatched size ` +
			`(tried size ${triedSize} with alignment ${triedAlign}, ` +
			`though the block was of size ${actualSize}) `
			`at 0x${pointer.toString(16)}`
		);
		this.pointer = pointer;
		this.triedSize = triedSize;
		this.triedAlign = triedAlign;
		this.actualSize = actualSize;
	}
}

class ReallocFreedError extends Error {
	/**
	 * @param {number} pointer
	 * @param {number} size
	 * @param {number} align
	 */
	constructor(pointer, size, align) {
		super(
			`tried to reallocate freed memory ` +
			`(of size ${size} with alignment ${align}) ` +
			`at 0x${pointer.toString(16)}`
		);
		this.pointer = pointer;
		this.size = size;
		this.align = align;
	}
}

class ReallocUnallocedError extends Error {
	/**
	 * @param {number} pointer
	 * @param {number} size
	 * @param {number} align
	 */
	constructor(pointer, size, align) {
		super(
			`tried to reallocate unallocated memory ` +
			`(of size ${size} with alignment ${align}) ` +
			`at 0x${pointer.toString(16)}`
		);
		this.pointer = pointer;
		this.size = size;
		this.align = align;
	}
}

class BlockSizeMismatchError extends Error {
	/**
	 * @param {number} pointer
	 * @param {number} expectedSize
	 * @param {number} align
	 * @param {number} actualSize
	 */
	constructor(pointer, expectedSize, align, actualSize) {
		super(
			`encountered memory block size mismatch ` +
			`(expected size ${expectedSize} with alignment ${align}, ` +
			`though the block was of size ${actualSize}) `
			`at 0x${pointer.toString(16)}`
		);
		this.pointer = pointer;
		this.expectedSize = expectedSize;
		this.align = align;
		this.actualSize = actualSize;
	}
}

class WasmModule {
	getExports() {
		const self = this;

		const exports = {};
		const prototype = Object.getPrototypeOf(self);
		for (const key of Object.getOwnPropertyNames(prototype)) {
			if (key === "constructor") { continue; }
			const value = prototype[key];
			if (value instanceof Function) {
				exports[key] = value.bind(self);
			} else {
				exports[key] = value;
			}
		}

		return exports;
	}
}

class PanicModule extends WasmModule {
	/**
	 * @param {Runner} runner
	 */
	constructor(runner) {
		super();
		this.runner = runner;
		this.message = '';
		this.file = undefined;
		this.line = 0;
		this.column = 0;
	}

	panic_ch(ch) {
		this.message += ch;
	}

	panic_str(pointer, length) {
		const str = this.runner.decodeUtf8(pointer, length);
		this.message += str;
	}

	panic_put_file(pointer, length) {
		this.file = this.runner.decodeUtf8(pointer, length);
	}

	panic_put_line_column(line, column) {
		this.line = line;
		this.column = column;
	}

	panic() {
		const line = this.line;
		const column = this.column;

		let file = this.file;
		if (file === undefined) {
			file = '?';
		}

		let message = this.message;
		if (message === '') {
			message = `<no message, ${file}:${line}:${column}>`;
		}

		throw new WasmPanicError(message, file, line, column);
	}
}

class DebugModule extends WasmModule {
	/**
	 * @param {Runner} runner
	 */
	constructor(runner) {
		super();
		this.runner = runner;
		this.dblog = [];
	}

	dblog_ch(code) {
		this.dblog.push(String.fromCodePoint(code));
	}

	dblog_str(pointer, length) {
		this.dblog.push(this.runner.decodeUtf8(pointer, length));
	}

	dblog_flush() {
		const data = this.dblog.join('');
		this.dblog = [];
		console.debug(data);
	}
}

class AllocBlock {
	/**
	 * @param {number} pointer
	 * @param {number} size
	 */
	constructor(pointer, size) {
		this.pointer = pointer;
		this.size = size;
		this.used = true;
	}

	static nextPointerWith(pointer, size) {
		return pointer + size;
	}

	nextPointer() {
		return AllocBlock.nextPointerWith(this.pointer, this.size);
	}
}

class AllocModule extends WasmModule {
	/**
	 * @param {Runner} runner
	 * @param {AllocBlock[]} blocks
	 */
	constructor(runner, blocks = []) {
		super();
		this.runner = runner;
		this.blocks = blocks;
	}

	/**
	 * @param {number} address
	 * @param {number} align
	 */
	static alignPointer(address, align) {
		return Math.ceil(address / align) * align;
	}

	/**
	 * @param {AllocModule} self
	 * @param {number} size
	 * @param {number} align
	 */
	static newBlock(self, size, align) {
		if (align < 1) {
			throw new TypeError("alignment cannot be less than 1");
		}

		const blocks = self.blocks;
		const blockCount = blocks.length;
		if (blockCount > 0) {
			let existingBlock;

			for (let i = 0; i < blockCount; ++i) {
				const block = blocks[i];
				if (block.used) { continue; }

				if (block.size >= size) {
					const prevBlock = blocks[i - 1];
					if (prevBlock !== undefined) {
						const alignedPointer = AllocModule.alignPointer(
							prevBlock.nextPointer(), align
						);

						const nextBlock = blocks[i + 1];
						if (nextBlock !== undefined) {
							if (AllocBlock.nextPointerWith(
								alignedPointer, size
							) > nextBlock.pointer)
							{
								continue;
							}
						}

						block.pointer = alignedPointer;
					}

					block.used = true;
					block.size = size;
					existingBlock = block;
					break;
				}
			}

			if (existingBlock !== undefined) {
				return existingBlock;
			}

			const lastBlock = blocks[blockCount - 1];
			const pointer = AllocModule.alignPointer(
				lastBlock.nextPointer(), align
			);

			existingBlock = new AllocBlock(pointer, size);
			blocks.push(existingBlock);
			return existingBlock;
		} else {
			const block = new AllocBlock(align, size);
			blocks.push(block);
			return block;
		}
	}

	alloc(size, align) {
		// console.debug("alloc", size, align);
		return AllocModule.newBlock(this, size, align).pointer;
	}

	dealloc(pointer, size, align) {
		// console.debug("dealloc", pointer, size, align);
		for (const block of this.blocks) {
			if (block.pointer === pointer) {
				if (!block.used) {
					throw new FreeAgainError(pointer, size, align);
				}

				if (block.size !== size) {
					throw new FreeMismatchedSizeError(
						pointer,
						size, align,
						block.size
					);
				}

				block.used = false;
				return;
			}
		}
		
		throw new FreeUnallocedError(pointer, size, align);
	}

	realloc(pointer, size, align, newSize) {
		// console.debug("realloc", pointer, size, align, "->", newSize);
		if (size === newSize) { return pointer; }

		let reallocBlock;
		for (const block of this.blocks) {
			if (block.pointer === pointer) {
				if (!block.used) {
					throw new ReallocFreedError(pointer, size, align);
				}

				if (block.size !== size) {
					throw new BlockSizeMismatchError(
						pointer, size, align,
						block.size
					);
				}

				reallocBlock = block;
				break;
			}
		}

		if (reallocBlock === undefined) {
			throw new ReallocUnallocedError(pointer, size, align);
		}

		// !!! CRITICAL SECTION !!!
		reallocBlock.used = false;
		const origData = new Uint8Array(
			this.runner.memory(),
			reallocBlock.pointer, size
		);

		const newBlock = AllocModule.newBlock(this, newSize, align);
		const newData = new Uint8Array(
			this.runner.memory(),
			newBlock.pointer, newSize
		);
		newData.set(origData);

		return newBlock.pointer;
	}
}

(async function () {
	const runner = new Runner();
	
	const { module, instance } = await WebAssembly.instantiateStreaming(
		fetch("./index.wasm"),
		{
			"alloc": (new AllocModule(runner)).getExports(),
			"debug": (new DebugModule(runner)).getExports(),
			"panic": (new PanicModule(runner)).getExports()
		}
	);

	runner.instantiate(module, instance);

	try {
		runner.getExportedFunction("run")();
	} catch (error) {
		console.error(error);
	}
})();
