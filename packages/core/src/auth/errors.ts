export class PermissionError extends Error {
  constructor (
    public readonly missingPermissions: string[],
    message: string
  ) {
    super(message)
    this.name = 'PermissionError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidCredentialsError'
  }
}
