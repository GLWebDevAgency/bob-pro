import { useState } from 'react';
import { View, Text, TextInput, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useAuth } from '../data/auth';
import { Button, font } from '../components/ui';

export function LoginScreen() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await signIn(email.trim(), password);
    setBusy(false);
    if (res.error) setError(res.error);
  }

  const inputStyle = {
    backgroundColor: colors.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.ink800,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 60, paddingHorizontal: 24, gap: 14 }}>
      <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Bob Pro</Text>
      <Text style={[font('body'), { color: colors.slate500 }]}>Connecte-toi pour accéder à ton bureau pro.</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        placeholderTextColor={colors.slate300}
        style={inputStyle}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Mot de passe"
        secureTextEntry
        placeholderTextColor={colors.slate300}
        style={inputStyle}
        onSubmitEditing={() => void submit()}
        returnKeyType="go"
      />
      {error ? <Text style={[font('sub'), { color: semantic.danger }]}>{error}</Text> : null}
      <Button title={busy ? 'Connexion…' : 'Se connecter'} disabled={busy} onPress={() => void submit()} />
      {busy ? <ActivityIndicator color={colors.ink800} /> : null}
    </View>
  );
}
