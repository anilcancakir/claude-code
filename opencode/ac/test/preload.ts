// The plugin log file stays off under test, so a run never appends to the operator's real log.
process.env.AC_OPENCODE_LOG = ""
