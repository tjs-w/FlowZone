import type { DynaSourceRef } from "./index.js";

export function sourceOrigin(value: string): string | undefined {
  try {
    const Url = (
      globalThis as unknown as {
        readonly URL: new (input: string) => {
          readonly protocol: string;
          readonly username: string;
          readonly password: string;
          readonly origin: string;
        };
      }
    ).URL;
    const url = new Url(value.includes("://") ? value : `https://${value}`);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function encodedPath(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function gitLabEntityPath(entityType: "merge_request" | "issue" | "pipeline"): string {
  return {
    merge_request: "merge_requests",
    issue: "issues",
    pipeline: "pipelines",
  }[entityType];
}

const SlackTeamIdPattern = /^T[A-Z0-9]{8,31}$/;
const SlackConversationIdPattern = /^[CDG][A-Z0-9]{8,31}$/;
const SlackMessageTimestampPattern = /^(\d{9,12})\.(\d{6})$/;
const SlackWorkspaceSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function slackSourceUrl(
  workspaceId: string,
  channelId: string,
  messageId: string,
): string | undefined {
  const timestamp = SlackMessageTimestampPattern.exec(messageId);
  if (!SlackConversationIdPattern.test(channelId) || !timestamp) return undefined;

  if (SlackTeamIdPattern.test(workspaceId)) {
    return `https://app.slack.com/client/${workspaceId}/${channelId}/thread/${channelId}-${messageId}`;
  }

  const workspaceSlug = workspaceId.toLocaleLowerCase("en-US");
  if (!SlackWorkspaceSlugPattern.test(workspaceSlug)) return undefined;
  return `https://${workspaceSlug}.slack.com/archives/${channelId}/p${timestamp[1]}${timestamp[2]}`;
}

/**
 * Builds a browser destination from the validated typed source identity. It never
 * accepts a publisher-supplied arbitrary URL.
 */
export function dynaSourceUrl(sourceRef: DynaSourceRef): string | undefined {
  switch (sourceRef.source) {
    case "slack":
      return slackSourceUrl(sourceRef.workspaceId, sourceRef.channelId, sourceRef.messageId);
    case "outlook":
      return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(sourceRef.messageId)}`;
    case "gitlab": {
      const origin = sourceOrigin(sourceRef.instanceId);
      if (!origin) return undefined;
      return `${origin}/${encodedPath(sourceRef.projectPath)}/-/${gitLabEntityPath(sourceRef.entityType)}/${String(sourceRef.iid)}`;
    }
    case "email": {
      const provider = sourceRef.provider.toLocaleLowerCase();
      if (provider.includes("outlook") || provider.includes("microsoft")) {
        return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(sourceRef.messageId)}`;
      }
      if (provider.includes("gmail") || provider.includes("google")) {
        return `https://mail.google.com/mail/u/${encodeURIComponent(sourceRef.accountId)}/#all/${encodeURIComponent(sourceRef.messageId)}`;
      }
      return undefined;
    }
    case "messaging": {
      const provider = sourceRef.provider.toLocaleLowerCase();
      if (provider.includes("slack")) {
        return slackSourceUrl(sourceRef.workspaceId, sourceRef.channelId, sourceRef.messageId);
      }
      if (provider.includes("discord")) {
        return `https://discord.com/channels/${encodeURIComponent(sourceRef.workspaceId)}/${encodeURIComponent(sourceRef.channelId)}/${encodeURIComponent(sourceRef.messageId)}`;
      }
      return undefined;
    }
    case "scm": {
      const origin = sourceOrigin(sourceRef.instanceId);
      if (!origin) return undefined;
      const repository = encodedPath(sourceRef.repository);
      const entityId = encodeURIComponent(sourceRef.entityId);
      const provider = sourceRef.provider.toLocaleLowerCase();
      if (provider.includes("gitlab")) {
        const entityType =
          sourceRef.entityType === "pull_request" ? "merge_request" : sourceRef.entityType;
        if (entityType === "commit") return `${origin}/${repository}/-/commit/${entityId}`;
        return `${origin}/${repository}/-/${gitLabEntityPath(entityType)}/${entityId}`;
      }
      if (provider.includes("github")) {
        const path = {
          pull_request: "pull",
          merge_request: "pull",
          issue: "issues",
          pipeline: "actions/runs",
          commit: "commit",
        }[sourceRef.entityType];
        return `${origin}/${repository}/${path}/${entityId}`;
      }
      if (provider.includes("bitbucket")) {
        const path = {
          pull_request: "pull-requests",
          merge_request: "pull-requests",
          issue: "issues",
          pipeline: "pipelines/results",
          commit: "commits",
        }[sourceRef.entityType];
        return `${origin}/${repository}/${path}/${entityId}`;
      }
      return undefined;
    }
    case "twg": {
      const origin = sourceOrigin(sourceRef.contextId);
      if (!origin) return undefined;
      if (sourceRef.resultType === "jira") {
        return `${origin}/browse/${encodeURIComponent(sourceRef.recordId)}`;
      }
      if (sourceRef.resultType === "confluence") {
        return `${origin}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(sourceRef.recordId)}`;
      }
      return undefined;
    }
    case "codex":
    case "skill":
    case "manual":
      return undefined;
  }
}
