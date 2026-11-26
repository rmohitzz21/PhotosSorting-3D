export const json = async (response: Response) => {
  if (!response.ok)
    throw Error(
      response.status === 409
        ? await response.text()
        : "Shoebox couldn’t finish that request. Please try again.",
    );
  return response.json();
};
