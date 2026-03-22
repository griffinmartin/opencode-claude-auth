.PHONY: build test lint fix format clean

build:
	pnpm run build

test:
	pnpm test

lint:
	pnpm run lint

fix:
	pnpm run lint:fix

format:
	pnpm run format

clean:
	rm -rf dist

all: lint build test
