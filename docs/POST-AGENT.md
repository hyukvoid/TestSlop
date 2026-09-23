# Post-agent check

After an AI coding assistant completes implementation and its own tests pass, run:

```bash
testslop twin
```

A portable instruction to add to an `AGENTS.md`, editor rule, or team checklist:

> After implementation and tests are complete, run `testslop twin`. If it finds an Evil Twin, report both expressions and the missing witness. A clean result does not prove correctness.

This is a post-action command only. It does not invoke or supervise an agent.
