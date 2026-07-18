export const meta = {
  name: 'reddone-recovery-audit',
  description: 'Recover interrupted ReDDone state and identify concrete validation gaps',
  phases: [
    { title: 'Recover', detail: 'Inspect repository, jobs, processes, scripts, and recent changes' },
    { title: 'Audit', detail: 'Review authentication, usage, tests, and quality risks' },
    { title: 'Synthesize', detail: 'Merge evidence into an execution-ready validation brief' }
  ]
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    concreteIssues: { type: 'array', items: { type: 'string' } },
    recommendedCommands: { type: 'array', items: { type: 'string' } },
    filesToInspectOrChange: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'evidence', 'concreteIssues', 'recommendedCommands', 'filesToInspectOrChange'],
  additionalProperties: false
}

phase('Recover')
const recovered = await parallel([
  () => agent(`Work read-only. Confirm the actual project root beginning at /Users/nr/Developer/reddone. Inspect directory structure, Git metadata, package.json, package manager, scripts, TypeScript/lint/test/build configs, and recently modified source/test files. Do not edit. Return exact paths, commands, and concrete anomalies only.`, { label: 'repo-and-scripts', phase: 'Recover', schema: REPORT_SCHEMA, agentType: 'Explore', effort: 'high' }),
  () => agent(`Work read-only. Inspect /Users/nr/.claude/jobs/5cb5e754 recursively, especially temporary verification scripts and any captured stdout/stderr/status. Check active Node, Next.js, Playwright, test-runner, and shell processes related specifically to /Users/nr/Developer/reddone. Determine whether prior commands completed, what passed/failed, and which processes are clearly stale. Do not kill or edit anything.`, { label: 'jobs-and-processes', phase: 'Recover', schema: REPORT_SCHEMA, agentType: 'general-purpose', effort: 'high' }),
  () => agent(`Work read-only in /Users/nr/Developer/reddone. Locate the implementation and tests for authentication redirects, returnTo preservation, sign-in continuation, usage granularity/state handling, marketing/account pages, and browser verification. Inspect current test coverage and likely smallest-to-full validation commands from package scripts. Do not execute broad destructive or mutating commands and do not edit.`, { label: 'feature-and-tests', phase: 'Recover', schema: REPORT_SCHEMA, agentType: 'Explore', effort: 'high' })
])

phase('Audit')
const audits = await parallel([
  () => agent(`Perform a read-only quality audit of /Users/nr/Developer/reddone. Search for TODO/FIXME, placeholders, temporary mocks, skipped tests, .only, disabled lint rules, unsafe TypeScript casts, swallowed errors, hard-coded development URLs, secrets, dead code, duplicate logic, inaccessible controls, hydration/server-client boundary issues, and obvious performance regressions. Verify every claimed issue against surrounding code and report only concrete actionable defects.`, { label: 'quality-audit', phase: 'Audit', schema: REPORT_SCHEMA, agentType: 'general-purpose', effort: 'xhigh' }),
  () => agent(`Perform a read-only correctness audit focused on /Users/nr/Developer/reddone authentication and usage data. Trace unauthenticated /usage?granularity=week redirects, returnTo encoding/preservation, post-sign-in continuation, granularity validation across navigation/refresh, loading/empty/error/populated states, API validation, usage aggregation and billing estimate assumptions. Compare test fixtures to actual contracts. Report concrete defects with exact paths/lines if possible.`, { label: 'auth-usage-audit', phase: 'Audit', schema: REPORT_SCHEMA, agentType: 'general-purpose', effort: 'xhigh' }),
  () => agent(`Perform a read-only UI/runtime audit of /Users/nr/Developer/reddone marketing pages and account flows. Inspect responsive overflow risks, labels/accessibility basics, console/network error hazards, design token consistency, duplicate components, and production-runtime assumptions. Also identify existing Playwright/browser harnesses and installed browser cache paths without installing anything. Report only evidenced concerns.`, { label: 'ui-runtime-audit', phase: 'Audit', schema: REPORT_SCHEMA, agentType: 'general-purpose', effort: 'high' })
])

phase('Synthesize')
const combined = [...recovered, ...audits].filter(Boolean)
const synthesis = await agent(`Synthesize these independent recovery/audit reports into an execution brief for the main agent. Deduplicate claims, distinguish verified facts from hypotheses, rank concrete issues by severity, propose the exact smallest-to-full validation order using actual package scripts, identify useful prior logs, and flag any clearly stale project process that may safely be killed. Do not invent evidence. Reports:\n${JSON.stringify(combined)}`, { label: 'recovery-synthesis', phase: 'Synthesize', schema: REPORT_SCHEMA, effort: 'xhigh' })

return { reports: combined, synthesis }
