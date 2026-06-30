import { useState } from 'react';
import { ScrollView, View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/theme';
import { useChantiers, useCreateChantier, useProfile, useSearchAddress } from '../src/data/hooks';
import { Card, Button, Badge, SectionHeader, font } from '../src/components/ui';

export default function Chantiers() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const moduleActive = (profile?.modules ?? []).some((m) => m.key === 'chantiers' && m.active);
  const { data: chantiers } = useChantiers(moduleActive);
  const create = useCreateChantier();
  const search = useSearchAddress();
  const [name, setName] = useState('');
  const [addr, setAddr] = useState('');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Retour" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Retour</Text>
        </Pressable>
      </View>

      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Chantiers</Text>

        {profileLoading ? (
          <ActivityIndicator color={colors.ink800} style={{ marginTop: 24 }} />
        ) : !moduleActive ? (
          <Card>
            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Module Chantiers</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>
              Regroupe devis, factures et situations par chantier. Inclus dès l’offre Solo (métiers du bâtiment), ou via le Pack BTP (+10 €/mois).
            </Text>
            <View style={{ marginTop: 12 }}>
              <Button title="Voir les offres" onPress={() => router.push('/compte')} />
            </View>
          </Card>
        ) : (
          <>
            <Card>
              <SectionHeader title="Nouveau chantier" />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Nom du chantier (ex. Villa Durand)"
                placeholderTextColor={colors.slate300}
                style={{ backgroundColor: colors.lineSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: colors.ink800, marginTop: 8 }}
              />
              <TextInput
                value={addr}
                onChangeText={(t) => {
                  setAddr(t);
                  // Autocomplétion BAN (le use case court-circuite < 3 caractères).
                  if (t.trim().length >= 3) search.mutate(t);
                }}
                placeholder="Adresse du chantier (optionnel)"
                placeholderTextColor={colors.slate300}
                accessibilityLabel="Adresse du chantier"
                style={{ backgroundColor: colors.lineSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: colors.ink800, marginTop: 8 }}
              />
              {(search.data ?? []).length > 0 ? (
                <View style={{ marginTop: 6, gap: 4 }}>
                  {(search.data ?? []).map((s, i) => (
                    <Pressable
                      key={`${s.label}-${i}`}
                      onPress={() => {
                        setAddr(s.label);
                        search.reset();
                      }}
                      accessibilityRole="button"
                      style={{ paddingVertical: 8, paddingHorizontal: 6 }}
                    >
                      <Text style={[font('sub'), { color: colors.ink800 }]}>{s.label}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={{ marginTop: 10 }}>
                <Button
                  title={create.isPending ? 'Création…' : 'Créer le chantier'}
                  disabled={!name.trim() || create.isPending}
                  onPress={() =>
                    create.mutate(
                      { name: name.trim(), address: addr.trim() || undefined },
                      {
                        onSuccess: () => {
                          setName('');
                          setAddr('');
                          search.reset();
                        },
                      },
                    )
                  }
                />
              </View>
            </Card>

            {(chantiers ?? []).length > 0 ? (
              <View>
                <SectionHeader title="Tes chantiers" />
                {(chantiers ?? []).map((c) => (
                  <Card key={c.id} style={{ marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={[font('cardTitle'), { color: colors.ink900, flex: 1 }]}>{c.name}</Text>
                      <Badge label={c.status === 'open' ? 'En cours' : 'Terminé'} tone={c.status === 'open' ? 'b2b' : 'success'} />
                    </View>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 4 }]}>Ouvert le {c.openedAt}</Text>
                  </Card>
                ))}
              </View>
            ) : (
              <Text style={[font('sub'), { color: colors.slate400 }]}>Aucun chantier pour l’instant.</Text>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
