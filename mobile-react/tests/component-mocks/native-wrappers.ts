export const SafeAreaView = 'SafeAreaView'
export const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 })
// Selectable AppText renders UITextView on iOS; as a 'Text' host it stays readable to text queries.
export const UITextView = 'Text'
export const Svg = 'Svg'
export default Svg
export const Circle = 'Circle'
export const Path = 'Path'
export const Rect = 'Rect'
export const Line = 'Line'
export const Polyline = 'Polyline'
export const Polygon = 'Polygon'
export const G = 'G'
export const KeyboardController = { async dismiss(_options?: unknown) {} }
// react-native-screens: the material overlay host draws through it.
export const FullWindowOverlay = 'FullWindowOverlay'
// expo-font: the material fonts load at once.
export async function loadAsync(_fonts: unknown) {}
