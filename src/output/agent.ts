import type { DiffSet } from '@/git/diff';
import type { ReviewEvent } from '@/review/engine';
import type { ReviewFinding, ReviewStats } from '@/review/schema';

// NDJSON "agent" protocol — one JSON object per line on stdout. Designed to be a
// drop-in superset of CodeRabbit's `--agent` event stream so existing agent
// integrations (Claude Code, Cursor, Kiro, …) work, while exposing the richer
// fields CodeRabbit hides (line ranges, category, confidence, reasoning, patch).

export type AgentEvent =
  | {
      type: 'review_context';
      reviewType: string;
      currentBranch?: string;
      baseBranch?: string;
      baseCommit?: string;
      workingDirectory: string;
    }
  | { type: 'status'; phase: string; status: string }
  | {
      type: 'finding';
      id: string;
      severity: string;
      fileName: string;
      startLine: number;
      endLine: number;
      title: string;
      category: string;
      confidence: number;
      comment: string;
      reasoning: string;
      codegenInstructions: string;
      suggestions: string[];
    }
  | {
      type: 'error';
      errorType:
        | 'auth'
        | 'connection'
        | 'network'
        | 'rate_limit'
        | 'review'
        | 'timeout'
        | 'unknown';
      message: string;
      recoverable: boolean;
    }
  | { type: 'heartbeat' }
  | { type: 'complete'; status: string; findings: number };

const PHASE_STATUS: Record<string, string> = {
  setup: 'setting_up',
  analyzing: 'building_code_graph',
  reviewing: 'review_started',
  summarizing: 'summarizing',
  completed: 'review_completed',
};

export class AgentEmitter {
  private write: (line: string) => void;
  private findingCount = 0;

  constructor(write: (line: string) => void = (l) => process.stdout.write(l)) {
    this.write = write;
  }

  private emit(event: AgentEvent): void {
    this.write(`${JSON.stringify(event)}\n`);
  }

  reviewContext(diff: DiffSet, workingDirectory: string): void {
    this.emit({
      type: 'review_context',
      reviewType: diff.target.kind,
      baseBranch: diff.base,
      baseCommit: diff.target.kind === 'commit' ? diff.head : undefined,
      currentBranch: diff.head,
      workingDirectory,
    });
  }

  // Wire as the engine's onEvent handler.
  onReviewEvent = (event: ReviewEvent): void => {
    if (event.type === 'status') {
      this.emit({
        type: 'status',
        phase: event.phase,
        status: PHASE_STATUS[event.phase] ?? event.phase,
      });
    } else if (event.type === 'finding') {
      this.findingCount += 1;
      this.emit(this.toFindingEvent(event.finding));
    } else if (event.type === 'tool_skipped') {
      this.emit({
        type: 'status',
        phase: 'analyzing',
        status: `tool_skipped:${event.name}`,
      });
    }
  };

  private toFindingEvent(f: ReviewFinding): AgentEvent {
    return {
      type: 'finding',
      id: f.id,
      severity: f.severity,
      fileName: f.file,
      startLine: f.startLine,
      endLine: f.endLine,
      title: f.title,
      category: f.category,
      confidence: f.confidence,
      comment: f.description,
      reasoning: f.rationale,
      codegenInstructions: f.codegenInstructions,
      suggestions: f.suggestedPatch ? [f.suggestedPatch] : [],
    };
  }

  heartbeat(): void {
    this.emit({ type: 'heartbeat' });
  }

  error(
    errorType: Extract<AgentEvent, { type: 'error' }>['errorType'],
    message: string,
    recoverable: boolean,
  ): void {
    this.emit({ type: 'error', errorType, message, recoverable });
  }

  complete(stats: ReviewStats): void {
    this.emit({
      type: 'complete',
      status: 'review_completed',
      findings: stats.findingsBySeverity
        ? Object.values(stats.findingsBySeverity).reduce((a, b) => a + b, 0)
        : this.findingCount,
    });
  }
}
