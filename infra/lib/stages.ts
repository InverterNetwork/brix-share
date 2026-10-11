/**
 * Stage configuration (account, domain, zone, alert routing). Not in the repository: maintainers keep it in the
 * STAGES_JSON repository variable and the deploy scripts write it to infra/stages.json (git-ignored).
 * infra/stages.example.json shows the format and drives CI synth and the tests.
 */
export interface StageConfig {
  name: string;
  account: string;
  region: string;
  domainName: string;
  /**
   * Serve on domainName (certificate, aliases, DNS records). Off until the zone is delegated: the site then
   * runs on the CloudFront default domain.
   */
  customDomain: boolean;
  /** Public base URL when customDomain is off (the CloudFront domain, known after the first deploy). */
  siteUrl?: string;
  hostedZone:
    { mode: 'existing'; zoneName: string; zoneId: string } | { mode: 'create'; zoneName: string };
  /**
   * Role path/name pattern (after `role/`) of the admin SSO role: the only principal that may assume the
   * web deploy role and read CloudFront access logs.
   */
  adminRolePattern: string;
  /** Random suffix of the files bucket name (8 to 16 lower-case letters and digits); fixed once deployed. */
  filesBucketSuffix: string;
  /** Optional e-mail subscribed to the alarm topic. */
  alarmEmail?: string;
  /**
   * Existing SNS topics in the stage's account and region that every alarm also notifies (state changes
   * to ALARM and back to OK), e.g. a team topic forwarded to Slack. Used as-is, never modified.
   */
  alarmTopicArns?: string[];
  /** Optional monthly AWS Budget (USD) on the app=brix-share cost allocation tag. */
  budgetUsd?: number;
}

/** Hosted zone as passed between stacks; `zoneId` may be a cross-stack token. */
export interface ZoneRef {
  zoneId: string;
  zoneName: string;
}

export function readStages(raw: unknown): StageConfig[] {
  if (typeof raw !== 'object' || raw === null) throw new Error('stages.json must be an object');
  return Object.entries(raw as Record<string, Partial<Omit<StageConfig, 'name'>>>).map(
    ([name, cfg]) => {
      if (!cfg.account || !/^\d{12}$/.test(cfg.account))
        throw new Error(`stage ${name}: account must be 12 digits`);
      if (!cfg.region || !cfg.domainName || !cfg.hostedZone || !cfg.adminRolePattern) {
        throw new Error(
          `stage ${name}: region, domainName, hostedZone and adminRolePattern required`,
        );
      }
      if (!cfg.filesBucketSuffix || !/^[a-z0-9]{8,16}$/.test(cfg.filesBucketSuffix))
        throw new Error(
          `stage ${name}: filesBucketSuffix must be 8 to 16 lower-case letters and digits`,
        );
      const topicArn = new RegExp(
        `^arn:aws:sns:${cfg.region}:${cfg.account}:[A-Za-z0-9_-]{1,256}$`,
      );
      for (const arn of cfg.alarmTopicArns ?? []) {
        if (!topicArn.test(arn))
          throw new Error(
            `stage ${name}: alarmTopicArns must be SNS topics in its account and region`,
          );
      }
      return {
        name,
        account: cfg.account,
        region: cfg.region,
        domainName: cfg.domainName,
        hostedZone: cfg.hostedZone,
        adminRolePattern: cfg.adminRolePattern,
        customDomain: cfg.customDomain === true,
        filesBucketSuffix: cfg.filesBucketSuffix,
        ...(cfg.siteUrl ? { siteUrl: cfg.siteUrl } : {}),
        ...(cfg.alarmEmail ? { alarmEmail: cfg.alarmEmail } : {}),
        ...(cfg.alarmTopicArns?.length ? { alarmTopicArns: cfg.alarmTopicArns } : {}),
        ...(cfg.budgetUsd ? { budgetUsd: cfg.budgetUsd } : {}),
      };
    },
  );
}
