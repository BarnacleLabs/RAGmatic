import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Banner, Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";

export const metadata = {
  // Define your metadata here
  // For more information on metadata API, see: https://nextjs.org/docs/app/building-your-application/optimizing/metadata
};

const banner = <Banner storageKey="some-key">Nextra 4.0 is released 🎉</Banner>;
const navbar = (
  <Navbar
    logo={<b>Ragmatic</b>}
    // ... Your additional navbar options
  />
);
const footer = <Footer>MIT {new Date().getFullYear()} © Ragmatic.</Footer>;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      // Not required, but good for SEO
      lang="en"
      // Required to be set
      dir="ltr"
      // Suggested by `next-themes` package https://github.com/pacocoursey/next-themes#with-app
      suppressHydrationWarning
    >
      <Head
        // ... Your additional head options
        faviconGlyph="✦"
        color={{
          hue: 94,
          saturation: 88,
          lightness: {
            light: 30,
            dark: 70,
          },
        }}
        backgroundColor={{
          light: "#fff",
          dark: "#0c0f0d",
        }}
      >
        {/* Your additional tags should be passed as `children` of `<Head>` element */}
      </Head>
      <body>
        <Layout
          // banner={banner}
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/shuding/nextra/tree/main/docs"
          footer={footer}
          // ... Your additional layout options
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
