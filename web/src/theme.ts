// 外观主题：深色（默认）、浅色、强光（高对比）、暖色，也可以跟着电脑的外观走。
// 实际生效靠 <html data-theme>，取值是 dark、light、sunlight、warm 之一；初始值由 index.html 里的内联脚本在样式加载前定好。

const THEME_KEY = 'innate-studio.theme';

export type ResolvedTheme = 'dark' | 'light' | 'sunlight' | 'warm';
export type ThemeChoice = ResolvedTheme | 'system';

// 设置里的选项顺序和文字。
export const THEME_OPTIONS: { value: ThemeChoice; label: string; desc: string }[] = [
  { value: 'system', label: '跟随系统', desc: '电脑是深色就用深色，浅色就用浅色' },
  { value: 'dark', label: '深色', desc: '默认。夜里和室内用' },
  { value: 'light', label: '浅色', desc: '白天室内用' },
  { value: 'sunlight', label: '强光（高对比）', desc: '户外、阳光直射下看得清：纯白底、纯黑字、边线加深' },
  { value: 'warm', label: '暖色', desc: '米黄纸色，长时间看着不刺眼' },
];

const RESOLVED: ResolvedTheme[] = ['dark', 'light', 'sunlight', 'warm'];
const systemLight = matchMedia('(prefers-color-scheme: light)');
const resolve = (choice: ThemeChoice): ResolvedTheme =>
  choice === 'system' ? (systemLight.matches ? 'light' : 'dark') : choice;

// 用户选的是哪一项。没选过是深色。
export function themeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'system' || RESOLVED.includes(saved as ResolvedTheme)) return saved as ThemeChoice;
  } catch {
    /* 读不到就按现在页面上的来 */
    return (RESOLVED.includes(document.documentElement.dataset.theme as ResolvedTheme) ? document.documentElement.dataset.theme : 'dark') as ResolvedTheme;
  }
  return 'dark';
}

export function setTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = resolve(choice);
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
}

// 选了跟随系统时，电脑的外观一变这里马上跟着变。
systemLight.addEventListener('change', () => {
  if (themeChoice() === 'system') document.documentElement.dataset.theme = resolve('system');
});
