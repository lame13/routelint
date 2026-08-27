import type {
  BuildInventory,
  Finding,
  PageCompletion,
  PageSnapshot,
  RedirectContract,
  RedirectContractCheck,
  RedirectContractObservation,
  RedirectContractReport,
  RedirectExpectation,
  RedirectTargetIndexability,
  RouteCandidate,
  RouteNode,
} from "./types.js";

export interface RedirectContractCollection {
  readonly contracts: readonly RedirectContract[];
  readonly skippedBuildRedirects: number;
}

export interface RedirectContractAudit {
  readonly findings: readonly Finding[];
  readonly report: RedirectContractReport;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NEXT_PATTERN_TOKEN = /[:*()[\]{}\\]/u;

function compareContracts(left: RedirectContract, right: RedirectContract): number {
  return left.from.localeCompare(right.from) || left.source.localeCompare(right.source);
}

function exactBuildUrl(value: string, baseUrl: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, baseUrl);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.origin !== new URL(baseUrl).origin ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    NEXT_PATTERN_TOKEN.test(parsed.pathname)
  ) {
    return undefined;
  }
  return parsed.href;
}

/** Merge configured contracts with concrete, unconditional Next.js build redirects. */
export function collectRedirectContracts(
  configured: readonly RedirectExpectation[],
  build: BuildInventory | undefined,
  baseUrl: string,
): RedirectContractCollection {
  const contracts = new Map<string, RedirectContract>();
  for (const expectation of configured) {
    contracts.set(expectation.from, { ...expectation, source: "config" });
  }

  let skippedBuildRedirects = 0;
  const conflictingBuildSources = new Set<string>();
  for (const redirect of build?.redirects ?? []) {
    const from = exactBuildUrl(redirect.source, baseUrl);
    const to = exactBuildUrl(redirect.destination, baseUrl);
    if (
      redirect.conditional === true ||
      from === undefined ||
      to === undefined ||
      from === to ||
      !REDIRECT_STATUSES.has(redirect.status)
    ) {
      skippedBuildRedirects += 1;
      continue;
    }

    if (contracts.get(from)?.source === "config") continue;
    if (conflictingBuildSources.has(from)) {
      skippedBuildRedirects += 1;
      continue;
    }

    const candidate: RedirectContract = {
      from,
      to,
      status: redirect.status as RedirectContract["status"],
      maxHops: 1,
      source: "next-build",
    };
    const existing = contracts.get(from);
    if (existing === undefined) {
      contracts.set(from, candidate);
      continue;
    }
    if (existing.to === candidate.to && existing.status === candidate.status) continue;

    contracts.delete(from);
    conflictingBuildSources.add(from);
    skippedBuildRedirects += 2;
  }

  return {
    contracts: [...contracts.values()].sort(compareContracts),
    skippedBuildRedirects,
  };
}

/** Add both sides of each redirect contract to the same-origin crawl frontier. */
export function redirectContractCandidates(
  contracts: readonly RedirectContract[],
): readonly RouteCandidate[] {
  return contracts.flatMap((contract) => [
    {
      url: contract.from,
      depth: 0,
      sources: [
        {
          kind: "redirect-contract" as const,
          from: contract.source,
          detail: "source",
        },
      ],
    },
    {
      url: contract.to,
      depth: 0,
      sources: [
        {
          kind: "redirect-contract" as const,
          from: contract.from,
          detail: "target",
        },
      ],
    },
  ]);
}

function primarySnapshot(route: RouteNode | undefined): PageSnapshot | undefined {
  return route?.snapshots[0];
}

function targetIndexability(snapshot: PageSnapshot): RedirectTargetIndexability {
  if (
    snapshot.completion !== "complete" ||
    snapshot.status === undefined ||
    snapshot.status < 200 ||
    snapshot.status >= 300 ||
    (snapshot.contentType !== undefined &&
      !/^(text\/html|application\/xhtml\+xml)\b/i.test(snapshot.contentType))
  ) {
    return "unknown";
  }

  const audience = snapshot.agent.key.toLowerCase();
  const directives = new Set(
    snapshot.signals.robots
      .filter(
        (signal) =>
          signal.audience === "robots" ||
          (audience === "googlebot" && signal.audience === "googlebot") ||
          (audience === "bingbot" && signal.audience === "bingbot"),
      )
      .flatMap((signal) => signal.value.toLowerCase().split(/[;,]/u))
      .map((value) => value.trim().split(/\s+/u, 1)[0] ?? "")
      .filter((value) => value.length > 0),
  );
  return directives.has("none") || directives.has("noindex") ? "noindex" : "indexable";
}

function uncheckedFinding(contract: RedirectContract, completion: string): Finding {
  return {
    code: "redirect-contract-unchecked",
    severity: "warning",
    url: contract.from,
    relatedUrls: [contract.to],
    message: `The redirect contract could not be checked (${completion}).`,
    evidence: {
      completion,
      expectedStatus: contract.status,
      maxHops: contract.maxHops,
    },
  };
}

function auditContract(
  contract: RedirectContract,
  routes: ReadonlyMap<string, RouteNode>,
): { readonly check: RedirectContractCheck; readonly findings: readonly Finding[] } {
  const snapshot = primarySnapshot(routes.get(contract.from));
  const completion: PageCompletion | "not-fetched" = snapshot?.completion ?? "not-fetched";
  const observed: RedirectContractObservation = {
    completion,
    hops: snapshot?.redirects ?? [],
    ...(snapshot?.finalUrl === undefined ? {} : { finalUrl: snapshot.finalUrl }),
    ...(snapshot?.status === undefined ? {} : { finalStatus: snapshot.status }),
    targetIndexability:
      snapshot === undefined || snapshot.redirects.length === 0
        ? ("unknown" as const)
        : targetIndexability(snapshot),
  };

  if (snapshot === undefined || snapshot.completion !== "complete") {
    const finding = uncheckedFinding(contract, completion);
    return {
      check: {
        contract,
        observed,
        outcome: "unchecked",
        findingCodes: [finding.code],
      },
      findings: [finding],
    };
  }

  const findings: Finding[] = [];
  const firstHop = snapshot.redirects[0];
  if (firstHop === undefined) {
    findings.push({
      code: "expected-redirect-missing",
      severity: "error",
      url: contract.from,
      relatedUrls: [contract.to],
      message: `Expected HTTP ${contract.status} redirect to ${contract.to}, but the route did not redirect.`,
      evidence: {
        expectedStatus: contract.status,
        ...(snapshot.status === undefined ? {} : { actualStatus: snapshot.status }),
      },
    });
  } else {
    if (firstHop.status !== contract.status) {
      findings.push({
        code: "redirect-status-mismatch",
        severity: "error",
        url: contract.from,
        relatedUrls: [contract.to],
        message: `Expected redirect status ${contract.status}, but the first hop returned ${firstHop.status}.`,
        evidence: { expectedStatus: contract.status, actualStatus: firstHop.status },
      });
    }
    if (snapshot.finalUrl !== contract.to) {
      findings.push({
        code: "redirect-target-mismatch",
        severity: "error",
        url: contract.from,
        relatedUrls: [...new Set([contract.to, snapshot.finalUrl])],
        message: `Expected the redirect to end at ${contract.to}, but it ended at ${snapshot.finalUrl}.`,
        evidence: { expectedTarget: contract.to, actualTarget: snapshot.finalUrl },
      });
    }
    if (snapshot.redirects.length > contract.maxHops) {
      findings.push({
        code: "redirect-chain",
        severity: "warning",
        url: contract.from,
        relatedUrls: snapshot.redirects.map((hop) => hop.location),
        message: `The redirect used ${snapshot.redirects.length} hops; the contract allows ${contract.maxHops}.`,
        evidence: { hops: snapshot.redirects.length, maxHops: contract.maxHops },
      });
    }
    if (
      snapshot.finalUrl === contract.to &&
      (snapshot.status === undefined ||
        snapshot.status < 200 ||
        snapshot.status >= 300 ||
        observed.targetIndexability === "noindex")
    ) {
      const health =
        observed.targetIndexability === "noindex"
          ? "is marked noindex"
          : snapshot.status === undefined
            ? "did not return an HTTP status"
            : `returned HTTP ${snapshot.status}`;
      findings.push({
        code: "redirect-target-unhealthy",
        severity: "error",
        url: contract.from,
        relatedUrls: [contract.to],
        message: `The expected redirect target ${health}.`,
        evidence: {
          ...(snapshot.status === undefined ? {} : { targetStatus: snapshot.status }),
          targetIndexability: observed.targetIndexability,
        },
      });
    }
  }

  return {
    check: {
      contract,
      observed,
      outcome: findings.length === 0 ? "verified" : "failed",
      findingCodes: findings.map((finding) => finding.code),
    },
    findings,
  };
}

/** Compare collected HTTP evidence with each effective redirect contract. */
export function auditRedirectContracts(
  routes: readonly RouteNode[],
  contracts: readonly RedirectContract[],
  skippedBuildRedirects = 0,
): RedirectContractAudit {
  const byUrl = new Map(routes.map((route) => [route.url, route]));
  const audited = contracts.map((contract) => auditContract(contract, byUrl));
  const checks = audited.map((result) => result.check);
  return {
    findings: audited.flatMap((result) => result.findings),
    report: {
      declared: checks.length,
      verified: checks.filter((check) => check.outcome === "verified").length,
      failed: checks.filter((check) => check.outcome === "failed").length,
      unchecked: checks.filter((check) => check.outcome === "unchecked").length,
      skippedBuildRedirects,
      checks,
    },
  };
}
