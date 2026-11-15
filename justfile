set shell := ["bash", "-cu"]

check:
    npm run fmt:check
    npm run lint
    npm run typecheck
    npm run knip
    npm run astgrep
    npm run secretlint
    npm run canary
    npm test

fmt:
    npm run fmt

dev:
    npm run dev

deploy:
    npm run deploy

doctor:
    npm run doctor

tail:
    npx wrangler tail

e2e:
    npm run e2e

perf:
    npm run perf

violations:
    npm run violations
