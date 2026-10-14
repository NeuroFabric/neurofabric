Operator runbooks for the two things only they can execute.

T10: enable the Linux gate for the two POSIX-only gates (measure-wrappers, assert-posix-vault-permissions). Includes what shared runners cost, why I am not editing .gitlab-ci.yml myself, and the reminder that the point of the gate is the log.

T11: relocate the runner config out of the repository root, with the pwsh/powershell note, verification, and the reminder that this is the moment to rotate the runner token.
