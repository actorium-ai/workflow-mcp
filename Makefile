.PHONY: install build watch typecheck lint lint-fix test test-coverage run start link unlink clean

install:
	pnpm install

build:
	pnpm run build

watch:
	pnpm run build:watch

typecheck:
	pnpm run typecheck

lint:
	pnpm run lint

lint-fix:
	pnpm run lint:fix

test:
	pnpm test

test-coverage:
	pnpm run test:coverage

start: build
	pnpm start

run: start

link: build
	PNPM_HOME="$${PNPM_HOME:-$$HOME/Library/pnpm}"; \
	export PNPM_HOME; \
	export PATH="$$PNPM_HOME:$$PATH"; \
	pnpm link --global

unlink:
	PNPM_HOME="$${PNPM_HOME:-$$HOME/Library/pnpm}"; \
	export PNPM_HOME; \
	export PATH="$$PNPM_HOME:$$PATH"; \
	pnpm remove --global "$$(node -p "require('./package.json').name")"

clean:
	rm -rf dist coverage
