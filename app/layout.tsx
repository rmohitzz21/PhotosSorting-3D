import "./style.css";
export const metadata = {
  title: "Shoebox · Photo library",
  description: "Organize your photos and review duplicate copies.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
