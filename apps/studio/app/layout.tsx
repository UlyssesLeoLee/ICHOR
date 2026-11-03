import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'AI Test Studio',description:'Git-native Playwright test control plane'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
