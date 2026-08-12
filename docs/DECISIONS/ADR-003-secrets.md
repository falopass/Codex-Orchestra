# ADR-003: credential boundary

Status: accepted

Orchestra never stores or reads provider secrets. Router/OS helpers own credential entry. The app exposes only status and safe remediation.
