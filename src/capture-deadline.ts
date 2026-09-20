export class CaptureDeadline<
  Stage extends string,
  TimeoutError extends Error
> {
  private readonly expiresAt: number;

  constructor(
    timeoutMs: number,
    private readonly createTimeoutError: (stage: Stage) => TimeoutError
  ) {
    this.expiresAt = performance.now() + timeoutMs;
  }

  remainingMilliseconds(): number {
    return Math.max(0, Math.ceil(this.expiresAt - performance.now()));
  }

  get expired(): boolean {
    return performance.now() >= this.expiresAt;
  }

  timeout(stage: Stage): TimeoutError {
    return this.createTimeoutError(stage);
  }

  run<T>(
    operation: () => Promise<T>,
    stage: Stage,
    onLateResolution?: (value: T, error: TimeoutError) => void,
    onLateRejection?: (error: unknown) => void
  ): Promise<T> {
    const remaining = this.remainingMilliseconds();
    if (remaining === 0) {
      return Promise.reject(this.timeout(stage));
    }
    const source = Promise.resolve().then(operation);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finishLate = (value: T) => {
        const error = this.timeout(stage);
        try {
          onLateResolution?.(value, error);
        } catch {
          // Late cleanup must not create an unhandled rejection.
        }
        return error;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(this.timeout(stage));
      }, remaining);
      timer.unref?.();

      source.then(
        (value) => {
          if (settled) {
            finishLate(value);
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (this.expired) {
            reject(finishLate(value));
          } else {
            resolve(value);
          }
        },
        (error) => {
          if (settled) {
            onLateRejection?.(error);
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (this.expired) {
            onLateRejection?.(error);
            reject(this.timeout(stage));
          } else {
            reject(error);
          }
        }
      );
    });
  }
}
