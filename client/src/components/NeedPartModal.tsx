import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { requestNeedPart } from '../api.ts';
import TurnstileWidget from './TurnstileWidget.tsx';
import PrivacyConsentText from './PrivacyConsentText.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const isCaptchaValidationError = (value: string) => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('РєР°РїС‡') ||
    normalized.includes('captcha') ||
    normalized.includes('РїСЂРѕРІРµСЂРє')
  );
};

const NeedPartModal = () => {
  const { needPartModal, closeNeedPartModal } = useUI();
  const { user } = useAuth();
  const product = needPartModal.product;
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

  const handleCaptchaTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token);
    if (token) {
      setError((prev) => (prev === 'РџРѕРґС‚РІРµСЂРґРёС‚Рµ, С‡С‚Рѕ РІС‹ РЅРµ СЂРѕР±РѕС‚.' ? null : prev));
    }
  }, []);

  useEffect(() => {
    if (!needPartModal.open) {
      return;
    }
    setFullName(user?.fullName ?? '');
    setPhone(formatPhone(user?.phone ?? ''));
    setCaptchaToken(null);
    setCaptchaResetKey((prev) => prev + 1);
    setAgreed(false);
    setIsSubmitted(false);
    setError(null);
    setIsSubmitting(false);
  }, [needPartModal.open, user]);

  if (!needPartModal.open || !product) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitted(false);
    setError(null);

    if (!fullName.trim() || !phone.trim()) {
      setError('Р—Р°РїРѕР»РЅРёС‚Рµ Р¤РРћ Рё РЅРѕРјРµСЂ С‚РµР»РµС„РѕРЅР°.');
      return;
    }
    if (!agreed) {
      setError('РќСѓР¶РЅРѕ СЃРѕРіР»Р°СЃРёС‚СЊСЃСЏ СЃ СѓСЃР»РѕРІРёСЏРјРё Рё РїРѕР»РёС‚РёРєРѕР№.');
      return;
    }
    if (turnstileSiteKey && !captchaToken) {
      setError('РџРѕРґС‚РІРµСЂРґРёС‚Рµ, С‡С‚Рѕ РІС‹ РЅРµ СЂРѕР±РѕС‚.');
      return;
    }

    setIsSubmitting(true);
    try {
      await requestNeedPart({
        productId: product.id,
        fullName: fullName.trim(),
        phone: phone.trim(),
        privacyConsent: true,
        captchaToken: captchaToken ?? undefined
      });
      setIsSubmitted(true);
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
    <div className="modal-backdrop" onClick={closeNeedPartModal}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">РќСѓР¶РЅР° РґРµС‚Р°Р»СЊ</p>
            <h3>Р—Р°РїСЂРѕСЃ РїРѕ С‚РѕРІР°СЂСѓ</h3>
          </div>
          <button className="icon-button" aria-label="Р—Р°РєСЂС‹С‚СЊ" onClick={closeNeedPartModal}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 17 17"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M16.5 0.5L0.5 16.5M16.5 16.5L0.5 0.5"
                stroke="#433F3C"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

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
          </div>
        ) : (
          <>
            <p className="muted">
              РўРѕРІР°СЂ: {product.name}
              {product.sku ? ` В· SKU ${product.sku}` : ''}
            </p>
            <form className="stacked-form" onSubmit={handleSubmit}>
              <label className="field">
                <span>Р¤РРћ</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="РРІР°РЅРѕРІ РРІР°РЅ РРІР°РЅРѕРІРёС‡"
                  required
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
                  action="request_need_part"
                  resetKey={captchaResetKey}
                  onTokenChange={handleCaptchaTokenChange}
                />
              )}
              {error && <p className="status-text status-text--error">{error}</p>}
              <div className="modal-actions">
                <button className="primary-button" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'РћС‚РїСЂР°РІР»СЏРµРј...' : 'РћС‚РїСЂР°РІРёС‚СЊ Р·Р°СЏРІРєСѓ'}
                </button>
                <button type="button" className="ghost-button" onClick={closeNeedPartModal}>
                  РћС‚РјРµРЅРёС‚СЊ
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default NeedPartModal;
