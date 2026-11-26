export type Exposure = {
  p1: number;
  p50: number;
  p99: number;
  clippedLow: number;
  clippedHigh: number;
};

/** Variance of the Laplacian response. Higher is sharper. Border pixels are skipped. */
export function sharpness(gray: Uint8Array, width: number, height: number) {
  if (width < 3 || height < 3) return 0;
  let sum = 0,
    sumSquares = 0,
    count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const response =
        gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += response;
      sumSquares += response * response;
      count++;
    }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/** Luma percentiles and the fraction of pixels pinned at pure black or pure white. */
export function exposure(gray: Uint8Array): Exposure {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  const total = gray.length || 1;
  const percentile = (fraction: number) => {
    let seen = 0;
    for (let value = 0; value < 256; value++) {
      seen += histogram[value];
      if (seen >= total * fraction) return value;
    }
    return 255;
  };
  return {
    p1: percentile(0.01),
    p50: percentile(0.5),
    p99: percentile(0.99),
    clippedLow: histogram[0] / total,
    clippedHigh: histogram[255] / total,
  };
}
