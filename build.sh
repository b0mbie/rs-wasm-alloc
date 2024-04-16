#!/usr/bin/env bash

if ! [ -x "$(which jq)" ]; then
	echo "$0: jq not found"
	exit 1
fi

cargo build --release || exit $?

# For this, I love
# https://github.com/rust-lang/cargo/issues/7895#issuecomment-1867761264
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps | jq -r '.target_directory')"
BIN_NAME="$(cargo metadata --format-version 1 --no-deps | jq -r '.packages[].targets[] | select( .kind as $kind | "cdylib" | IN($kind[]) ) | .name')"
BINARY_PATH="$TARGET_DIR/wasm32-unknown-unknown/release/${BIN_NAME//-/_}.wasm"

cp "$BINARY_PATH" "./index.wasm"
