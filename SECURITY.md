# Reporting a security vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/e-dialect/wanyu-proofreader/security/advisories/new) for suspected vulnerabilities. This repository has private reporting enabled. Include affected versions, reproduction steps using synthetic data, and the expected access boundary.

Do not put credentials, private source material, account details or exploit instructions in public issues. Ordinary bug reports can use the public issue forms. This project does not currently publish a response-time SLA or a separate security mailbox; no response deadline is promised here.

Security fixes target the current main branch. Older deployments should update to a release containing the fix. Keep the report private while maintainers assess the impact and coordinate disclosure.

## Automated checks

Pull requests run dependency audits, a standalone Gitleaks history scan, and Trivy vulnerability scans of the actual backend/frontend images built by CI. CI uploads CycloneDX SBOMs for all three images, including the isolated OCR worker. High/critical findings and scanner errors fail the corresponding checks. Reports are CI artifacts, not evidence that an application has no vulnerabilities.

These tools run on existing GitHub runners and do not send the repository to a paid scanning service. Vulnerability database downloads still use the scanners' upstream registries. See [the quality baseline](docs/quality-baseline.md) for scope and budget decisions.
