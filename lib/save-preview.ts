import { save } from "./preview-store";
import { derive } from "./derive";
export async function savePreview(user: string, id: string, input: Buffer) {
  const { work, thumb, bits, pixels } = await derive(input);
  const store = (label: string, data: Buffer) =>
    save(user + "/" + id + "/" + label + ".jpg", data);
  return {
    small: await store("thumb", thumb),
    large: await store("work", work),
    pixels: pixels.toString("base64"),
    phash: bits.toString(16),
  };
}
