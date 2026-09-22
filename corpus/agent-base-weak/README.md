# agent-base-weak

Identical production code to `corpus/agent-base`. The **only** difference is that the
existing test suite is written in a weak style: existence checks, truthiness,
bare `toThrow()`, and snapshot-ish assertions instead of exact expectations.

## Why this exists

The POC-01 benchmark found that Codex wrote 301 assertions across 24 tasks with
**zero** at or below EXISTENCE. One plausible explanation is agent quality. Another
is **style contagion**: agents imitate the conventions they find in a repository, and
`corpus/agent-base` ships an exemplary suite full of exact assertions.

If the base rate is a property of the agent, it should hold here too. If it is a
property of the surrounding code, it should collapse.

This is a controlled comparison: same agent, same task prompts, same production
code, only the existing test style differs.

Tests are otherwise faithful: they pass, they cover the same functions, and they are
the kind of thing that exists in real codebases.
