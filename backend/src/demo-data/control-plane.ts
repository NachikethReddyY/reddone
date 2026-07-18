export type ProjectStatus =
  | "researching"
  | "spec-review"
  | "building"
  | "release-ready"
  | "live"
  | "paused";

export type HealthTone = "success" | "warning" | "danger" | "info" | "neutral";

export type DemoProject = {
  id: string;
  name: string;
  oneLiner: string;
  status: ProjectStatus;
  stageLabel: string;
  progress: number;
  blocker: string;
  nextAction: string;
  sourceMode: "fixture" | "import" | "live";
  communities: string[];
  findingCount: number;
  evidenceDelta: number;
  sandbox: string;
  repository: string;
  deployment: string;
  nextResearch: string;
  nextPolish: string;
  updatedAt: string;
};

export const projects: DemoProject[] = [
  {
    id: "latepay-copilot",
    name: "LatePay Copilot",
    oneLiner: "Turns overdue invoices into a calm, evidence-backed follow-up queue.",
    status: "release-ready",
    stageLabel: "Release approval",
    progress: 88,
    blocker: "Production release needs your approval",
    nextAction: "Review release",
    sourceMode: "fixture",
    communities: ["r/freelance", "r/smallbusiness", "r/consulting"],
    findingCount: 18,
    evidenceDelta: 4,
    sandbox: "Verified",
    repository: "Private / ready",
    deployment: "Preview healthy",
    nextResearch: "Today, 15:00",
    nextPolish: "Paused for approval",
    updatedAt: "8 min ago",
  },
  {
    id: "visadoc-watcher",
    name: "VisaDoc Watcher",
    oneLiner: "Tracks shifting visa document requirements and flags changes before submission.",
    status: "researching",
    stageLabel: "Evidence scan",
    progress: 36,
    blocker: "Waiting for the current import to finish",
    nextAction: "Watch run",
    sourceMode: "import",
    communities: ["r/visas", "r/immigration"],
    findingCount: 11,
    evidenceDelta: 7,
    sandbox: "Not created",
    repository: "Not created",
    deployment: "Not deployed",
    nextResearch: "Running now",
    nextPolish: "Not scheduled",
    updatedAt: "21 min ago",
  },
  {
    id: "scopeguard",
    name: "ScopeGuard",
    oneLiner: "Finds scope creep in client threads and turns it into change-order drafts.",
    status: "spec-review",
    stageLabel: "Spec review",
    progress: 54,
    blocker: "Product spec has 2 unresolved decisions",
    nextAction: "Edit spec",
    sourceMode: "fixture",
    communities: ["r/agency", "r/webdev"],
    findingCount: 23,
    evidenceDelta: 2,
    sandbox: "Reserved",
    repository: "Not created",
    deployment: "Not deployed",
    nextResearch: "Tomorrow, 09:00",
    nextPolish: "Off",
    updatedAt: "Yesterday",
  },
];

export const providerConnections = [
  {
    id: "kimi",
    name: "AIand",
    role: "AIand-powered research, specification, and bounded code generation",
    status: "connected" as const,
    account: "api.tokenrouter.com",
    scopes: ["chat.completions", "structured-output"],
    suffix: "k9F2",
    testedAt: "2 min ago",
    latency: "812 ms",
  },
  {
    id: "daytona",
    name: "Daytona",
    role: "Isolated builder and verifier sandboxes",
    status: "connected" as const,
    account: "reddone-production",
    scopes: ["sandbox:create", "sandbox:network"],
    suffix: "3nQ8",
    testedAt: "11 min ago",
    latency: "421 ms",
  },
  {
    id: "github",
    name: "GitHub",
    role: "Private repositories and verified source commits",
    status: "attention" as const,
    account: "ReDDone Builder · Acme Labs",
    scopes: ["contents:write", "metadata:read"],
    suffix: "App #248197",
    testedAt: "Yesterday",
    latency: "Installation needs renewal",
  },
  {
    id: "vercel",
    name: "Vercel",
    role: "Prebuilt artifact deployment and promotion",
    status: "connected" as const,
    account: "Acme Labs / Production",
    scopes: ["project:write", "deployment:write"],
    suffix: "Team 84c7",
    testedAt: "18 min ago",
    latency: "267 ms",
  },
  {
    id: "reddit",
    name: "Reddit",
    role: "Approved API research source",
    status: "locked" as const,
    account: "No authorization recorded",
    scopes: ["read"],
    suffix: "Not configured",
    testedAt: "Never",
    latency: "Live access disabled",
  },
];

export const findings = [
  {
    id: "f-01",
    rank: 1,
    problem: "Clients ignore invoices until the follow-up feels personal",
    summary:
      "Independent consultants spend hours rewriting the same escalating reminder because generic sequences feel too aggressive or too easy to ignore.",
    source: "r/freelance",
    sourceId: "fixture-freelance-1042",
    permalink: "https://www.reddit.com/r/freelance/",
    excerpt:
      "I spend more energy deciding how firm the next email should be than I did sending the invoice.",
    attribution: "Anonymized fixture · 3 months ago",
    scores: { frequency: 9, urgency: 8, buildability: 9, confidence: 8 },
    mentions: 14,
    selected: true,
  },
  {
    id: "f-02",
    rank: 2,
    problem: "Payment context is scattered across email, contracts, and accounting tools",
    summary:
      "Operators cannot see promises, invoice history, and relationship context in one place before choosing the next step.",
    source: "r/smallbusiness",
    sourceId: "fixture-smallbiz-873",
    permalink: "https://www.reddit.com/r/smallbusiness/",
    excerpt:
      "The invoice says overdue, but the real story is buried in six emails and a phone call I forgot to note.",
    attribution: "Anonymized fixture · 5 months ago",
    scores: { frequency: 8, urgency: 9, buildability: 7, confidence: 8 },
    mentions: 11,
    selected: false,
  },
  {
    id: "f-03",
    rank: 3,
    problem: "Freelancers delay follow-up to protect the client relationship",
    summary:
      "The emotional cost of asking for payment causes avoidable cash-flow delays, especially for solo operators.",
    source: "r/consulting",
    sourceId: "fixture-consulting-442",
    permalink: "https://www.reddit.com/r/consulting/",
    excerpt:
      "I know the invoice is late. I just don't want a normal reminder to make a good client feel accused.",
    attribution: "Anonymized fixture · 7 weeks ago",
    scores: { frequency: 7, urgency: 8, buildability: 9, confidence: 7 },
    mentions: 9,
    selected: false,
  },
];

export const productSpec = {
  id: "spec_lpc_06",
  version: 6,
  hash: "sha256:8ca92d…f103",
  updatedAt: "Today, 13:42",
  oneLiner: "A calm collections copilot for independent service businesses.",
  targetUser:
    "Freelancers and small agencies with 5–50 open invoices who manage client relationships personally.",
  coreWorkflow: [
    "Import an invoice and its conversation context",
    "Review a risk-aware follow-up recommendation",
    "Edit and approve the message",
    "Track the promise date and next safe action",
  ],
  features: [
    "Context timeline for invoice, messages, and promises",
    "Tone-calibrated reminder drafts with evidence notes",
    "Human approval before any message is copied or sent",
    "Aging queue ordered by cash risk and relationship sensitivity",
  ],
  nonGoals: [
    "No automatic email sending in v1",
    "No payment processing or accounting system writes",
    "No legal collection advice",
  ],
  acceptance: [
    "A user can add an overdue invoice in under two minutes",
    "Every draft names the evidence that influenced its tone",
    "No external action happens without a visible approval",
    "The mobile queue remains usable at 200% zoom",
  ],
};

export const buildSteps = [
  { id: "01", label: "Reserve budget", detail: "$7.50 approved ceiling", state: "complete" as const, duration: "0.4s" },
  { id: "02", label: "Create builder sandbox", detail: "snapshot reddone-next-v4", state: "complete" as const, duration: "18s" },
  { id: "03", label: "Generate application", detail: "8 / 20 model turns", state: "complete" as const, duration: "11m 42s" },
  { id: "04", label: "Export manifest", detail: "18 allowlisted files · simulated", state: "complete" as const, duration: "3.2s" },
  { id: "05", label: "Verify in clean sandbox", detail: "8 / 8 gates passed", state: "complete" as const, duration: "4m 11s" },
  { id: "06", label: "Await release approval", detail: "Signed preview URL · 15 minute expiry", state: "active" as const, duration: "Now" },
];

export const buildLog = [
  "13:20:08  policy     protected toolchain manifest loaded",
  "13:20:26  sandbox    builder sbx_bld_8a21 ready; outbound network denied",
  "13:21:02  builder    reading ProductSpec v6 (sha256:8ca92d…f103)",
  "13:24:19  builder    added invoice queue and context timeline",
  "13:28:41  builder    added tone review and approval boundary",
  "13:31:58  manifest   42 files accepted; 0 protected paths changed",
  "13:32:16  verifier   fresh sandbox sbx_vfy_19cc ready",
  "13:34:07  verifier   typecheck · lint · unit · secret scan passed",
  "13:36:27  verifier   Playwright smoke passed at 390px and 1440px",
  "13:36:31  artifact   signed report vrf_39f2; preview ready",
];

export const verificationChecks = [
  ["Manifest integrity", "Passed", "18 files match artifact hash"],
  ["Protected paths", "Passed", "No immutable files changed"],
  ["Secret scan", "Passed", "0 candidate secrets"],
  ["Static analysis", "Passed", "0 high or critical findings"],
  ["Typecheck + lint", "Passed", "Clean"],
  ["Unit tests", "Passed", "34 / 34"],
  ["Browser smoke", "Passed", "6 / 6 journeys"],
  ["Production build", "Passed", "Build Output API ready"],
] as const;

export const deployments = [
  {
    id: "dpl_preview_02",
    environment: "Preview",
    state: "healthy" as const,
    url: "latepay-copilot-pr-6.vercel.app",
    commit: "c18f23a",
    createdAt: "Today, 13:38",
    note: "Verified candidate · not assigned to production",
  },
  {
    id: "dpl_prod_01",
    environment: "Production",
    state: "healthy" as const,
    url: "latepay-copilot.vercel.app",
    commit: "8b7d09f",
    createdAt: "Jul 8, 17:20",
    note: "Last-known-good · rollback target",
  },
  {
    id: "dpl_preview_01",
    environment: "Preview",
    state: "failed" as const,
    url: "latepay-copilot-pr-5.vercel.app",
    commit: "f04ab11",
    createdAt: "Jul 8, 16:58",
    note: "Health check failed · never promoted",
  },
];

export const activityEvents = [
  { time: "13:42", type: "approval", title: "Release approval requested", detail: "Artifact vrf_39f2 is ready for review", tone: "warning" as HealthTone },
  { time: "13:36", type: "verification", title: "Clean verification passed", detail: "8 security and quality gates passed", tone: "success" as HealthTone },
  { time: "13:32", type: "artifact", title: "Builder artifact accepted", detail: "42 allowlisted files; protected toolchain unchanged", tone: "info" as HealthTone },
  { time: "13:20", type: "build", title: "Build run started", detail: "Budget reserved and isolated sandbox created", tone: "neutral" as HealthTone },
  { time: "12:54", type: "spec", title: "Product spec v6 approved", detail: "Approved by workspace owner", tone: "success" as HealthTone },
];

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export const approvalQueue = [
  {
    id: "apr_release_lpc_06",
    projectId: "latepay-copilot",
    projectName: "LatePay Copilot",
    type: "First release",
    title: "Promote verified build to production",
    status: "pending" as ApprovalStatus,
    requestedAt: "Today, 13:42",
    expires: "Today, 19:00",
    summary: "Create a private GitHub repository and promote the verified Vercel artifact after health checks.",
    risk: "This creates external resources and may incur provider usage.",
    payload: [
      ["Specification", "v6 · sha256:8ca92d…f103"],
      ["Artifact", "vrf_39f2 · sha256:55b14e…9c20"],
      ["Repository", "Private · Acme Labs"],
      ["Deployment", "Acme Labs / production"],
      ["Secret grants", "None"],
      ["Cost ceiling", "$4.00"],
    ],
  },
  {
    id: "apr_spec_scope_03",
    projectId: "scopeguard",
    projectName: "ScopeGuard",
    type: "Specification build",
    title: "Build ProductSpec v3",
    status: "pending" as ApprovalStatus,
    requestedAt: "Yesterday, 18:04",
    expires: "Tomorrow, 18:04",
    summary: "Start a bounded builder run using the selected scope-creep finding.",
    risk: "Up to 20 model turns and 30 sandbox minutes will be reserved.",
    payload: [
      ["Specification", "v3 · sha256:3ef820…7ad1"],
      ["Builder", "AIand · moonshotai/kimi-k2.7-code"],
      ["Sandbox", "Daytona · two isolated runs"],
      ["Cost ceiling", "$12.00"],
    ],
  },
  {
    id: "apr_polish_lpc_05",
    projectId: "latepay-copilot",
    projectName: "LatePay Copilot",
    type: "Polish release",
    title: "Add a clearer empty invoice state",
    status: "rejected" as ApprovalStatus,
    requestedAt: "Jul 7, 10:20",
    expires: "Resolved Jul 7, 11:02",
    summary: "A scheduled evidence scan proposed changing the first-run flow.",
    risk: "Rejected: wait until evidence includes first-time users.",
    payload: [["Upstream artifact", "ProductSpec v5"]],
  },
];

export const chatMessages = [
  {
    id: "m1",
    role: "system" as const,
    author: "Research orchestrator",
    time: "12:47",
    body: "I found three strong problem clusters. The late-payment follow-up problem leads on frequency and buildability.",
  },
  {
    id: "m2",
    role: "owner" as const,
    author: "You",
    time: "12:49",
    body: "Keep the first version focused on calm follow-up drafting. Do not send email automatically.",
  },
  {
    id: "m3",
    role: "system" as const,
    author: "Specification agent",
    time: "12:51",
    body: "Understood. ProductSpec v6 makes human approval mandatory and excludes outbound email from v1.",
  },
  {
    id: "m4",
    role: "agent" as const,
    author: "Release orchestrator",
    time: "13:42",
    body: "The verified preview is ready. Review the structured release approval before any repository or production resource is created.",
  },
];

export const schedules = [
  {
    id: "research-hourly",
    name: "Hourly evidence research",
    description: "Check the approved source for new pain, objections, and feature evidence.",
    cadence: "Every hour",
    enabled: true,
    nextRun: "Today, 15:00 SGT",
    lastRun: "Today, 14:00 · 4 new signals",
    tone: "info" as HealthTone,
  },
  {
    id: "polish-five-hour",
    name: "Five-hour polish proposal",
    description: "Turn new evidence into a reviewable improvement proposal. Production never changes automatically.",
    cadence: "Every 5 hours",
    enabled: false,
    nextRun: "Paused for release approval",
    lastRun: "Jul 7, 10:00 · proposal rejected",
    tone: "warning" as HealthTone,
  },
];
