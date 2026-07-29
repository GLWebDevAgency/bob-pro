import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type Instant } from '../../shared-kernel/time';
import { type InterventionProps } from '../../domain/intervention/intervention';
import { type CompanyRepository } from '../ports/repositories';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError, lockInterventionForMutation } from './intervention-mutation';

export interface SignInterventionInput {
  companyId: string;
  interventionId: string;
  expectedRevision: number;
  signerName: string;
  /**
   * SHA-256 (hex) du tracé RÉELLEMENT reçu — calculé CÔTÉ SERVEUR par la frontière (patron
   * signQuote, P0 R4) : le client ne fournit JAMAIS le hash. REQUIS : une signature de fiche
   * sans tracé n'existe pas (client absent = fiche `completed` non signée, jamais fabriquée).
   */
  proofSha256: string;
  /**
   * Heure du GESTE déclarée par l'appareil (capture hors-ligne §3.6.5) — le serveur pose
   * `capturedAt` (réception) et `syncedAt` ; jamais confondues (§3.4, P12).
   */
  capturedAtDevice?: Instant;
}

export interface SignInterventionDeps {
  interventions: InterventionRepository;
  companies: CompanyRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/**
 * §3.5 — signature de la fiche, MÊME chorégraphie transactionnelle que SignQuote : verrou
 * société (SHARE) → verrou fiche (UPDATE) → transition — une clôture de compte concurrente
 * est entièrement avant ou après. Après quoi la fiche est VERROUILLÉE (doctrine §3.4) ;
 * seule la séquence erratum 6 (retrait de photo → note automatique) reste acceptée AVANT ce
 * geste. Valeur probante « signature simple » eIDAS — dite telle quelle (LegalHint).
 */
export class SignIntervention {
  constructor(private readonly deps: SignInterventionDeps) {}

  async execute(input: SignInterventionInput): Promise<Result<InterventionProps, AppError>> {
    try {
      const props = await this.deps.uow.runInTransaction(async () => {
        const company = await this.deps.companies.lockForShareById(input.companyId);
        if (!company || company.isClosed()) {
          throw new TxAppError(
            appDomain({ code: 'VALIDATION', field: 'company', message: 'Société introuvable ou clôturée.' }),
          );
        }
        const intervention = await lockInterventionForMutation(this.deps.interventions, input);

        const at = this.deps.clock.now();
        const offline = input.capturedAtDevice !== undefined;
        const signed = intervention.sign({
          signerName: input.signerName,
          method: 'onsite_draw',
          sha256: input.proofSha256,
          // capturedAt = horodatage SERVEUR de réception (en ligne : immédiat ; offline : rejeu).
          capturedAt: at,
          ...(offline ? { capturedAtDevice: input.capturedAtDevice as Instant, syncedAt: at } : {}),
        });
        if (!signed.ok) throw new TxAppError(appDomain(signed.error));
        await this.deps.interventions.save(intervention);
        return intervention.toProps();
      });
      return ok(props);
    } catch (e) {
      if (e instanceof TxAppError) return err(e.appError);
      throw e;
    }
  }
}
