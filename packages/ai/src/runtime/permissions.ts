import { type AnyTool } from '../tools/tool';
import { type RuntimeMode, type ComplianceLevel } from './journal';

const COMPLIANCE_RANK: Record<ComplianceLevel, number> = { low: 0, medium: 1, high: 2 };

/** Métadonnées d'outil nécessaires à une décision de permission (sous-ensemble de Tool). */
export type ToolFacts = Pick<AnyTool, 'name' | 'mutating' | 'outbound' | 'compliance'>;

export interface ActionContext {
  readonly tool: ToolFacts;
  readonly args: Record<string, unknown>;
  readonly mode: RuntimeMode;
}

export interface PermissionDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

export type PermissionRule = (ctx: ActionContext) => PermissionDecision;

export interface ActionPolicyOptions {
  /** Si défini : SEULS ces outils sont permis (allowlist stricte). */
  readonly allow?: readonly string[];
  /** Refus explicite (prioritaire sur tout le reste). */
  readonly deny?: readonly string[];
  /** Plafond de risque conformité : refuse les outils au-dessus, sauf s'ils sont dans `allow`. */
  readonly maxCompliance?: ComplianceLevel;
  /** Refuse toute action modifiante (rôle lecture seule). */
  readonly readOnly?: boolean;
  /** Règles additionnelles composables : la PREMIÈRE qui refuse gagne. */
  readonly rules?: readonly PermissionRule[];
}

/**
 * Moteur de permissions PAR ACTION. À ne pas confondre avec la confirmation :
 * - permission  = « a-t-on le DROIT d'exécuter cet outil ? » (ce module)
 * - confirmation = « faut-il demander à l'utilisateur avant ? » (autonomy.ts / BobAgent)
 * Ordre d'évaluation : deny > readOnly > allowlist > plafond conformité > règles custom > autorisé.
 */
export class ActionPolicy {
  constructor(private readonly opts: ActionPolicyOptions = {}) {}

  static allowAll(): ActionPolicy {
    return new ActionPolicy();
  }

  decide(ctx: ActionContext): PermissionDecision {
    const name = ctx.tool.name;

    if (this.opts.deny?.includes(name)) {
      return { allow: false, reason: `Outil « ${name} » explicitement interdit.` };
    }
    if (this.opts.readOnly && ctx.tool.mutating) {
      return { allow: false, reason: `Mode lecture seule : « ${name} » modifie l'état.` };
    }
    if (this.opts.allow && !this.opts.allow.includes(name)) {
      return { allow: false, reason: `Outil « ${name} » hors de la liste autorisée.` };
    }
    if (this.opts.maxCompliance && !this.opts.allow?.includes(name)) {
      if (COMPLIANCE_RANK[ctx.tool.compliance] > COMPLIANCE_RANK[this.opts.maxCompliance]) {
        return {
          allow: false,
          reason: `Conformité « ${ctx.tool.compliance} » au-dessus du plafond « ${this.opts.maxCompliance} ».`,
        };
      }
    }
    for (const rule of this.opts.rules ?? []) {
      const d = rule(ctx);
      if (!d.allow) return d;
    }
    return { allow: true };
  }
}
