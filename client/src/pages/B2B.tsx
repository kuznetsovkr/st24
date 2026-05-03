import { useCallback, useMemo, useState, type FormEvent } from 'react';
import TurnstileWidget from '../components/TurnstileWidget.tsx';
import PrivacyConsentText from '../components/PrivacyConsentText.tsx';
import { requestB2BInquiry } from '../api';
import { formatPhone } from '../utils/formatPhone.ts';
import { SITE_URL, usePageSeo } from '../utils/usePageSeo.ts';

const isCaptchaValidationError = (value: string) => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('РєР°РїС‡') ||
    normalized.includes('captcha') ||
    normalized.includes('РїСЂРѕРІРµСЂРє')
  );
};

const B2BPage = () => {
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [comment, setComment] = useState('');
  const [enterpriseCard, setEnterpriseCard] = useState<File | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();
  const breadcrumbJsonLd = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Р“Р»Р°РІРЅР°СЏ',
          item: `${SITE_URL}/`
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'B2B',
          item: `${SITE_URL}/b2b`
        }
      ]
    }),
    []
  );

  usePageSeo(
    'Р—Р°РїСЂРѕСЃ РґР»СЏ СЋСЂРёРґРёС‡РµСЃРєРёС… Р»РёС† | РЎРў-24',
    'Р—Р°РїРѕР»РЅРёС‚Рµ С„РѕСЂРјСѓ B2B-Р·Р°РїСЂРѕСЃР° РІ РЎРў-24, С‡С‚РѕР±С‹ РїРѕР»СѓС‡РёС‚СЊ РєРѕРјРјРµСЂС‡РµСЃРєРѕРµ РїСЂРµРґР»РѕР¶РµРЅРёРµ РЅР° Р·Р°РїС‡Р°СЃС‚Рё РґР»СЏ С‚РµС…РЅРёРєРё Karcher.',
    {
      jsonLd: breadcrumbJsonLd
    }
  );

  const handleCaptchaTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token);
    if (token) {
      setError((prev) => (prev === 'РџРѕРґС‚РІРµСЂРґРёС‚Рµ, С‡С‚Рѕ РІС‹ РЅРµ СЂРѕР±РѕС‚.' ? '' : prev));
    }
  }, []);

  const resetForm = () => {
    setCompanyName('');
    setContactPerson('');
    setPhone('');
    setEmail('');
    setComment('');
    setEnterpriseCard(null);
    setAgreed(false);
    setCaptchaToken(null);
    setCaptchaResetKey((prev) => prev + 1);
    setError('');
    setIsSubmitted(false);
    setIsSubmitting(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setIsSubmitted(false);

    if (!companyName.trim()) {
      setError('РЈРєР°Р¶РёС‚Рµ Р¤РРћ РёР»Рё РЅР°Р·РІР°РЅРёРµ РєРѕРјРїР°РЅРёРё.');
      return;
    }

    if (!phone.trim()) {
      setError('РЈРєР°Р¶РёС‚Рµ С‚РµР»РµС„РѕРЅ РґР»СЏ СЃРІСЏР·Рё.');
      return;
    }

    if (!agreed) {
      setError('РќСѓР¶РЅРѕ РїРѕРґС‚РІРµСЂРґРёС‚СЊ СЃРѕРіР»Р°СЃРёРµ СЃ СѓСЃР»РѕРІРёСЏРјРё Рё РїРѕР»РёС‚РёРєРѕР№.');
      return;
    }

    if (turnstileSiteKey && !captchaToken) {
      setError('РџРѕРґС‚РІРµСЂРґРёС‚Рµ, С‡С‚Рѕ РІС‹ РЅРµ СЂРѕР±РѕС‚.');
      return;
    }

    const payload = new FormData();
    payload.append('companyName', companyName.trim());
    payload.append('contactPerson', contactPerson.trim());
    payload.append('phone', phone.trim());
    payload.append('email', email.trim());
    payload.append('comment', comment.trim());
    payload.append('privacyConsent', 'true');
    if (captchaToken) {
      payload.append('captchaToken', captchaToken);
    }
    if (enterpriseCard) {
      payload.append('enterpriseCard', enterpriseCard);
    }

    setIsSubmitting(true);
    try {
      await requestB2BInquiry(payload);
      setIsSubmitted(true);
      setCompanyName('');
      setContactPerson('');
      setPhone('');
      setEmail('');
      setComment('');
      setEnterpriseCard(null);
      setCaptchaToken(null);
      setCaptchaResetKey((prev) => prev + 1);
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
        if (turnstileSiteKey && isCaptchaValidationError(submitError.message)) {
          setCaptchaToken(null);
          setCaptchaResetKey((prev) => prev + 1);
        }
      } else {
        setError('РќРµ СѓРґР°Р»РѕСЃСЊ РѕС‚РїСЂР°РІРёС‚СЊ Р·Р°СЏРІРєСѓ.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Р”Р»СЏ СЋСЂРёРґРёС‡РµСЃРєРёС… Р»РёС†</p>
          <h1>B2B-Р·Р°СЏРІРєР°</h1>
          <p className="muted">РћСЃС‚Р°РІСЊС‚Рµ РґР°РЅРЅС‹Рµ РєРѕРјРїР°РЅРёРё, Рё РјС‹ РїРѕРґРіРѕС‚РѕРІРёРј РїСЂРµРґР»РѕР¶РµРЅРёРµ.</p>
        </div>
      </header>

      <div className="card">
        {isSubmitted ? (
          <div className="need-part-success" role="status" aria-live="polite">
            <div className="need-part-success-icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="17" height="13" viewBox="0 0 17 13" fill="none">
                <path
                  className="need-part-success-check"
                  d="M16.5 0.5L5.3 12.5L0.5 8"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <p className="status-text need-part-success-text">Р—Р°СЏРІРєР° РѕС‚РїСЂР°РІР»РµРЅР°. РњС‹ СЃРІСЏР¶РµРјСЃСЏ СЃ РІР°РјРё.</p>
            <button type="button" className="ghost-button" onClick={resetForm}>
              Р—Р°РїРѕР»РЅРёС‚СЊ РЅРѕРІСѓСЋ Р·Р°СЏРІРєСѓ
            </button>
          </div>
        ) : (
          <form className="stacked-form" onSubmit={handleSubmit}>
            <div className="form-grid">
              <label className="field">
                <span>Р¤РРћ РёР»Рё РЅР°Р·РІР°РЅРёРµ РєРѕРјРїР°РЅРёРё</span>
                <input
                  type="text"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="РћРћРћ РџСЂРёРјРµСЂ / РРІР°РЅРѕРІ РРІР°РЅ РРІР°РЅРѕРІРёС‡"
                  required
                />
              </label>
              <label className="field">
                <span>РљРѕРЅС‚Р°РєС‚РЅРѕРµ Р»РёС†Рѕ</span>
                <input
                  type="text"
                  value={contactPerson}
                  onChange={(event) => setContactPerson(event.target.value)}
                  placeholder="РРјСЏ РјРµРЅРµРґР¶РµСЂР°"
                />
              </label>
              <label className="field">
                <span>РўРµР»РµС„РѕРЅ</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(formatPhone(event.target.value))}
                  placeholder="+7"
                  required
                />
              </label>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="mail@example.com"
                />
              </label>
            </div>

            <label className="field">
              <span>РљР°СЂС‚РѕС‡РєР° РїСЂРµРґРїСЂРёСЏС‚РёСЏ (С„Р°Р№Р»)</span>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setEnterpriseCard(file);
                }}
              />
              <span className="form-help">
                PDF, DOC, DOCX, XLS, XLSX, JPG, PNG. РњР°РєСЃРёРјР°Р»СЊРЅС‹Р№ СЂР°Р·РјРµСЂ: 10 РњР‘.
              </span>
            </label>

            <label className="field">
              <span>РљРѕРјРјРµРЅС‚Р°СЂРёР№</span>
              <textarea
                rows={4}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="РЈС‚РѕС‡РЅРµРЅРёСЏ РїРѕ Р·Р°СЏРІРєРµ"
              />
            </label>

            <label className="checkbox-field checkbox-field--legal">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <PrivacyConsentText openInNewTab />
            </label>

            {turnstileSiteKey && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                action="request_b2b"
                resetKey={captchaResetKey}
                onTokenChange={handleCaptchaTokenChange}
              />
            )}

            {error ? <p className="status-text status-text--error">{error}</p> : null}

            <div className="button-row">
              <button className="primary-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'РћС‚РїСЂР°РІР»СЏРµРј...' : 'РћС‚РїСЂР°РІРёС‚СЊ Р·Р°РїСЂРѕСЃ'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default B2BPage;
