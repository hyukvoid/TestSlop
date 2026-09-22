export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message, "validation_failed");
  }
}

export class OutOfStock extends DomainError {
  constructor(
    public readonly sku: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`${sku}: requested ${requested}, only ${available} available`, "out_of_stock");
  }
}

export class InvalidTransition extends DomainError {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`cannot move order from ${from} to ${to}`, "invalid_transition");
  }
}

export class SignatureMismatch extends DomainError {
  constructor() {
    super("webhook signature does not match", "signature_mismatch");
  }
}
