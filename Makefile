.PHONY: build test test-models lint fix format clean intercept intercept-all intercept-update

build:
	pnpm run build

test:
	pnpm test

test-models:
	pnpm run test:models

lint:
	pnpm run lint

fix:
	pnpm run lint:fix

format:
	pnpm run format

clean:
	rm -rf dist

intercept:
	pnpm run intercept

intercept-all:
	pnpm run intercept:all

intercept-update:
	pnpm run intercept:update

all: lint build test
