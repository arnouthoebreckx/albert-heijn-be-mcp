.PHONY: setup check audit

# No dependency needs install scripts; skipping them keeps a compromised one from running code.
setup:
	npm ci --ignore-scripts

# The one gate: CI runs this target too.
check:
	npm run lint
	npm run build
	npm test
	npm_config_ignore_scripts=true npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json

audit:
	npm audit --omit=dev --audit-level=high
