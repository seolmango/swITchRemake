import { createContext, useContext } from 'react';

export const GameContainerScaleContext = createContext(1);
/** Actual transform applied to the fixed design stage. Portalled controls intentionally ignore it. */
export const useGameContainerScale = (): number => useContext(GameContainerScaleContext);
