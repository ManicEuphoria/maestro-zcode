# NOTICE

## Upstream project

This tool is a community port layer for running
[**Maestro-Flow**](https://github.com/catlog22/Maestro-Flow) (npm: `maestro-flow`, MIT License,
© catlog22 and contributors) on the [ZCode](https://z.ai) harness.

- `generate.mjs` reads the **locally installed** `maestro-flow` npm package and mechanically
  transforms its assets (frontmatter flattening, tool-name mapping, term replacement) into a
  ZCode plugin at generation time. **No upstream content is stored in this repository** —
  everything is derived on your machine from your own maestro-flow install.
- `hook-shim.mjs` is original adapter code (ZCode ⇄ Claude Code hook protocol translation).

All credit for the workflow system itself — commands, skills, agents, hooks, the
Session/Run lifecycle — belongs to the Maestro-Flow authors. Please star and support
the upstream project.

## Non-affiliation

This is an independent community project. It is not affiliated with or endorsed by
catlog22/Maestro-Flow, Z.ai, or any of their maintainers.
