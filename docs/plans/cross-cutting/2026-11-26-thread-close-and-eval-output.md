# Thread closure and eval output

Status: Active.

Subagent kill used to interrupt one turn: queued sibling messages and nested
background completions could wake the child after its original activity settled.
Dismiss hid the branch without stopping it. Separately, nested text-only tool
results passed through the same file preview as direct calls before JavaScript
could process them, while eval rejected large final output before it could spill.

- [ ] Close a thread and its descendants durably before stopping their work. Wire
      kill and dismiss to the same operation; keep ordinary turn interruption,
      ordinary process termination and unrelated conversations unchanged. Verify
      delayed delivery, resumed children, restart, and sibling isolation.
- [x] Skip file previews on nested tool calls only. A focused real-evaluator
      service test selects the last line of a 42 KB text-only tool response
      and verifies the unselected text is absent from the next model request.
- [ ] Remove eval's text display limit; use bounded buffering and the ordinary
      output store for large text. Verify large returns and repeated emissions,
      including errors and cancellation; preserve separate image and bridge limits.
- [ ] Review behavior, lifecycle/simplicity, and evidence independently; resolve
      findings, synchronize subsystem and testing docs, and run `npm run check`.
- [ ] Commit validated changes, push to the confirmed branch, and verify the
      patch release workflow and its published assets.
