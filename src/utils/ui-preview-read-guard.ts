export interface UiPreviewReadGuardOptions {
    burstLimit?: number;
    burstWindowMs?: number;
    quietPeriodMs?: number;
    now?: () => number;
}

export interface UiPreviewReadDecision {
    allowed: boolean;
    retryAfterMs?: number;
    tripped?: boolean;
}

const DEFAULT_BURST_LIMIT = 4;
const DEFAULT_BURST_WINDOW_MS = 1250;
const DEFAULT_QUIET_PERIOD_MS = 1500;

export function isUiPreviewReadCall(name: string, args: unknown): boolean {
    return (
        name === 'read_file'
        && typeof args === 'object'
        && args !== null
        && (args as { origin?: unknown }).origin === 'ui'
    );
}

/**
 * Bounds stale/replayed file-preview hydration without throttling model-facing
 * reads. A normal preview can burst a few reads, but once the burst limit is
 * exceeded the circuit remains open until UI read traffic has been quiet for
 * the configured period. Requests received while open extend that quiet period,
 * so a 250 ms replay storm cannot repeatedly re-arm itself.
 */
export class UiPreviewReadCircuitBreaker {
    private readonly burstLimit: number;
    private readonly burstWindowMs: number;
    private readonly quietPeriodMs: number;
    private readonly now: () => number;
    private recentAllowedAt: number[] = [];
    private blockedUntil = 0;

    constructor(options: UiPreviewReadGuardOptions = {}) {
        this.burstLimit = options.burstLimit ?? DEFAULT_BURST_LIMIT;
        this.burstWindowMs = options.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
        this.quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
        this.now = options.now ?? Date.now;
    }

    tryAcquire(): UiPreviewReadDecision {
        const now = this.now();

        if (now < this.blockedUntil) {
            this.blockedUntil = now + this.quietPeriodMs;
            return {
                allowed: false,
                retryAfterMs: this.quietPeriodMs,
            };
        }

        this.recentAllowedAt = this.recentAllowedAt.filter(
            (timestamp) => now - timestamp < this.burstWindowMs,
        );

        if (this.recentAllowedAt.length >= this.burstLimit) {
            this.recentAllowedAt = [];
            this.blockedUntil = now + this.quietPeriodMs;
            return {
                allowed: false,
                retryAfterMs: this.quietPeriodMs,
                tripped: true,
            };
        }

        this.recentAllowedAt.push(now);
        return { allowed: true };
    }
}
