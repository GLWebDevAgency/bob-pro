import { type DomainResult, ok, err } from '../../shared-kernel/result';

/**
 * PR-09 « Le métier » — contact multiple d'un client (exigence 1, conception domaine §0) :
 * une fiche client entreprise/publique compte PLUSIEURS personnes jointes (demandeur, valideur,
 * compta…). Modèle MINIMAL généralisable : le `label` LIBRE porte le rôle (« Compta »,
 * « Valideur BC ») — aucune taxonomie codée en dur. `Customer.contactName`/`email` historiques
 * restent la coordonnée par défaut de la fiche ; les contacts s'y AJOUTENT (additif).
 * Le choix du destinataire à l'envoi d'une pièce passe par resolveExplicitRecipientEmail
 * (send-invoice.ts, PR-01) — jamais un remplacement silencieux de l'email de la fiche.
 */

export interface CustomerContactProps {
  id: string;
  companyId: string;
  customerId: string;
  /** Rôle LIBRE du contact (« Compta », « Valideur », « Gardien du site »…) — 1..80. */
  label: string;
  /** Nom de la personne — 1..160. */
  name: string;
  /** E-mail joignable (destinataire possible d'une pièce) — optionnel. */
  email?: string | null;
  /** Téléphone (texte libre court) — optionnel. */
  phone?: string | null;
  revision?: number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONTROL_CHARS = /[\p{Cc}]/u;

function cleanedLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Contact validé et normalisé — la SEULE forme qui se persiste (fail-closed sinon). */
export class CustomerContact {
  private constructor(private readonly p: Required<Omit<CustomerContactProps, 'email' | 'phone'>> & {
    email: string | null;
    phone: string | null;
  }) {}

  static of(props: CustomerContactProps): DomainResult<CustomerContact> {
    const id = props.id.trim();
    if (!id) return err({ code: 'VALIDATION', field: 'id', message: 'Identifiant de contact requis.' });
    const companyId = props.companyId.trim();
    if (!companyId)
      return err({ code: 'VALIDATION', field: 'companyId', message: 'Tenant du contact requis.' });
    const customerId = props.customerId.trim();
    if (!customerId)
      return err({ code: 'VALIDATION', field: 'customerId', message: 'Client du contact requis.' });

    const label = cleanedLine(props.label);
    if (label.length === 0 || label.length > 80 || CONTROL_CHARS.test(label))
      return err({ code: 'VALIDATION', field: 'label', message: 'Rôle du contact requis (80 caractères maximum).' });

    const name = cleanedLine(props.name);
    if (name.length === 0 || name.length > 160 || CONTROL_CHARS.test(name))
      return err({ code: 'VALIDATION', field: 'name', message: 'Nom du contact requis (160 caractères maximum).' });

    let email: string | null = null;
    if (props.email !== undefined && props.email !== null && props.email.trim().length > 0) {
      email = props.email.trim().toLowerCase();
      if (email.length > 320 || !EMAIL_PATTERN.test(email))
        return err({ code: 'VALIDATION', field: 'email', message: 'Adresse e-mail du contact invalide.' });
    }

    let phone: string | null = null;
    if (props.phone !== undefined && props.phone !== null && props.phone.trim().length > 0) {
      phone = cleanedLine(props.phone);
      if (phone.length > 40 || CONTROL_CHARS.test(phone))
        return err({ code: 'VALIDATION', field: 'phone', message: 'Téléphone du contact invalide (40 caractères maximum).' });
    }

    const revision = props.revision ?? 1;
    if (!Number.isSafeInteger(revision) || revision < 1)
      return err({ code: 'VALIDATION', field: 'revision', message: 'Révision de contact invalide.' });

    return ok(new CustomerContact({ id, companyId, customerId, label, name, email, phone, revision }));
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get customerId(): string {
    return this.p.customerId;
  }
  get label(): string {
    return this.p.label;
  }
  get name(): string {
    return this.p.name;
  }
  get email(): string | null {
    return this.p.email;
  }
  get phone(): string | null {
    return this.p.phone;
  }
  get revision(): number {
    return this.p.revision;
  }

  toProps(): CustomerContactProps {
    return {
      id: this.p.id,
      companyId: this.p.companyId,
      customerId: this.p.customerId,
      label: this.p.label,
      name: this.p.name,
      email: this.p.email,
      phone: this.p.phone,
      revision: this.p.revision,
    };
  }
}
