import { useCallback, useState } from 'react';

export interface UseQuantitySelectorOptions {
  min?: number;
  max?: number;
  initial?: number;
}

/** Local UI state for a quantity stepper. Not tied to any order or persistence yet. */
export function useQuantitySelector({ min = 0, max = 20, initial = 0 }: UseQuantitySelectorOptions = {}) {
  const [quantity, setQuantity] = useState(initial);

  const increment = useCallback(() => {
    setQuantity((current) => Math.min(max, current + 1));
  }, [max]);

  const decrement = useCallback(() => {
    setQuantity((current) => Math.max(min, current - 1));
  }, [min]);

  return { quantity, increment, decrement, min, max };
}
