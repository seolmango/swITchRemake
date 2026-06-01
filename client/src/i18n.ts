import i18n from 'i18next';
import { initReactI18next } from "react-i18next";
import koTranslation from './locales/ko.json';
import enTranslation from './locales/en.json';

i18n
    .use(initReactI18next)
    .init({
        resources: {
            ko: { translation: koTranslation },
            en: { translation: enTranslation }
        },
        lng: 'ko',
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false
        }
    });

export default i18n;