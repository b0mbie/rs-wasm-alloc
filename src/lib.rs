//! External allocator.

#![no_std]

extern crate alloc;

use alloc::alloc::{
	GlobalAlloc,
	Layout
};
use core::fmt::{
	self,
	Write
};
use core::panic::PanicInfo;

#[link(wasm_import_module = "alloc")]
extern "C" {
	fn alloc(size: usize, alignment: usize) -> *mut u8;
	fn dealloc(ptr: *mut u8, size: usize, alignment: usize);
	fn realloc(
		ptr: *mut u8,
		size: usize, alignment: usize,
		new_size: usize
	) -> *mut u8;
}

#[panic_handler]
pub fn panic_handler(info: &PanicInfo) -> ! {
	#[link(wasm_import_module = "panic")]
	extern "C" {
		fn panic() -> !;
		fn panic_put_file(file: *const u8, len: usize);
		fn panic_put_line_column(line: usize, col: usize);
		fn panic_ch(ch: u32);
		fn panic_str(str: *const u8, len: usize);
	}

	#[derive(Debug)]
	pub struct Panic;
	
	impl Write for Panic {
		fn write_char(&mut self, ch: char) -> fmt::Result {
			unsafe { panic_ch(ch as u32) };
			Ok(())
		}
	
		fn write_str(&mut self, s: &str) -> fmt::Result {
			unsafe { panic_str(s.as_ptr(), s.len()) };
			Ok(())
		}
	}

	if let Some(message) = info.payload().downcast_ref::<&'static str>() {
		let _ = write!(Panic, "{}", message);
	} else {
		let _ = write!(Panic, "{}", info);
	}

	if let Some(location) = info.location() {
		unsafe {
			let file = location.file();
			panic_put_file(file.as_ptr(), file.len());
			panic_put_line_column(
				location.line() as usize,
				location.column() as usize
			);
		};
	}

	unsafe { panic() }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExternAllocator;

unsafe impl GlobalAlloc for ExternAllocator {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		alloc(layout.size(), layout.align())
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		dealloc(ptr, layout.size(), layout.align())
	}

	unsafe fn realloc(
		&self,
		ptr: *mut u8, layout: Layout,
		new_size: usize
	) -> *mut u8 {
		realloc(ptr, layout.size(), layout.align(), new_size)
	}
}

#[global_allocator]
pub static mut GLOBAL_ALLOCATOR: ExternAllocator = ExternAllocator;

#[export_name = "run"]
pub extern "C" fn run() {
	use alloc::string::String;
	use alloc::vec::Vec;

	#[allow(dead_code)]
	#[derive(Debug)]
	struct User {
		id: usize,
		name: String
	}

	let _: String = "taketwo".into();

	let mut stuff = Vec::new();
	for _ in 0..100 {
		stuff.push(42);
	}
	
	#[link(wasm_import_module = "debug")]
	extern "C" {
		fn dblog_ch(ch: u32);
		fn dblog_str(ptr: *const u8, len: usize);
		fn dblog_flush();
	}
	
	#[derive(Debug)]
	pub struct DebugLog;

	impl DebugLog {
		#[inline]
		pub fn flush(&mut self) {
			unsafe { dblog_flush() }
		}
	}
	
	impl Write for DebugLog {
		fn write_char(&mut self, ch: char) -> fmt::Result {
			unsafe { dblog_ch(ch as u32) };
			Ok(())
		}
	
		fn write_str(&mut self, s: &str) -> fmt::Result {
			unsafe { dblog_str(s.as_ptr(), s.len()) };
			Ok(())
		}
	}

	let user = User {
		id: 1337,
		name: "track one".into()
	};

	let mut user_info = String::new();
	user_info.push_str(&user.name);
	let _ = writeln!(DebugLog, "{}", user_info);
	DebugLog.flush();
}
