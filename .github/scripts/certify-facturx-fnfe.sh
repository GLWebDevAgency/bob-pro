#!/usr/bin/env bash
set -euo pipefail

# Gate normatif reproductible pour les nouvelles émissions Factur-X EN16931.
# Le pack complet est épinglé : changer de millésime ou de règle requiert une revue explicite.
FNFE_VERSION='1.4.0.02'
FNFE_ARCHIVE_NAME='2026_07_13_FNFE_SCHEMATRONS_FR_CTC_V1.4.0.02'
FNFE_URL='https://fnfe-mpe.org/wp-content/uploads/2026/07/2026_07_13_FNFE_SCHEMATRONS_FR_CTC_V1.4.0.02.zip'
FNFE_SHA256='e007f85206b7085e6a9d20402a22f93136b25690e021fc06838b9f7bbc202e18'

SAXON_VERSION='13.0'
SAXON_URL="https://repo.maven.apache.org/maven2/net/sf/saxon/Saxon-HE/${SAXON_VERSION}/Saxon-HE-${SAXON_VERSION}.jar"
SAXON_SHA256='258fb4788b8e1bd986f9aed14269669412da88c7bb289b747878d4353f6168aa'
XMLRESOLVER_VERSION='6.0.23'
XMLRESOLVER_URL="https://repo.maven.apache.org/maven2/org/xmlresolver/xmlresolver/${XMLRESOLVER_VERSION}/xmlresolver-${XMLRESOLVER_VERSION}.jar"
XMLRESOLVER_SHA256='8bd99540e826dada93126fa05c3a0b54f5db00701d7be98193673099307e77e2'
XMLRESOLVER_DATA_URL="https://repo.maven.apache.org/maven2/org/xmlresolver/xmlresolver/${XMLRESOLVER_VERSION}/xmlresolver-${XMLRESOLVER_VERSION}-data.jar"
XMLRESOLVER_DATA_SHA256='0614b78ce484ce33670dc842b75efc8961af9bd6145edb65a34865dc521629de'

XSD_SHA256='977654a4e0442885a3d622ca198cff414f467eebc93098654b98127f2349f066'
PROFILE_XSLT_SHA256='ad17794b088dfb89a5e92c9e3b9a2f6663b95bd12b23677667e3e7996d1c4b1f'
PROFILE_CODEDB_SHA256='faa3ef78a23a5910e9c90bbcd3c3de5e45b6a84a3d62e11e1e6097fa466d52d8'
FRANCE_XSLT_SHA256='6dede5f39a4573cc0a30d3bd47ba1e1584de83c9096d70db91efbf5aa9e5a59e'

XML_PATH="${1:?Usage: certify-facturx-fnfe.sh <factur-x.xml> [work-dir] [bundle-dir]}"
WORK_DIR="${2:-${RUNNER_TEMP:-/tmp}/bob-fnfe-${FNFE_VERSION}}"
BUNDLE_DIR="${3:-${WORK_DIR}}"
DOWNLOAD_DIR="${BUNDLE_DIR}/downloads"
RULES_DIR="${BUNDLE_DIR}/rules"
REPORT_DIR="${WORK_DIR}/reports"
mkdir -p "${DOWNLOAD_DIR}" "${RULES_DIR}" "${REPORT_DIR}"

FNFE_ZIP="${DOWNLOAD_DIR}/fnfe-${FNFE_VERSION}.zip"
SAXON_JAR="${DOWNLOAD_DIR}/Saxon-HE-${SAXON_VERSION}.jar"
XMLRESOLVER_JAR="${DOWNLOAD_DIR}/xmlresolver-${XMLRESOLVER_VERSION}.jar"
XMLRESOLVER_DATA_JAR="${DOWNLOAD_DIR}/xmlresolver-${XMLRESOLVER_VERSION}-data.jar"

download_and_verify() {
  local url="$1"
  local output="$2"
  local expected_sha="$3"
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 3 --connect-timeout 20 \
    --output "${output}" "${url}"
  verify_sha256 "${output}" "${expected_sha}"
}

verify_sha256() {
  local file="$1"
  local expected_sha="$2"
  local actual_sha
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha="$(sha256sum "${file}" | awk '{ print $1 }')"
  else
    actual_sha="$(shasum -a 256 "${file}" | awk '{ print $1 }')"
  fi
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    printf 'SHA-256 invalide pour %s : attendu %s, obtenu %s.\n' \
      "${file}" "${expected_sha}" "${actual_sha}" >&2
    return 1
  fi
  printf '%s: SHA-256 certifié.\n' "${file}"
}

download_if_missing_and_verify() {
  local url="$1"
  local output="$2"
  local expected_sha="$3"
  if [[ -f "${output}" ]]; then
    verify_sha256 "${output}" "${expected_sha}"
  else
    download_and_verify "${url}" "${output}" "${expected_sha}"
  fi
}

download_if_missing_and_verify "${FNFE_URL}" "${FNFE_ZIP}" "${FNFE_SHA256}"
download_if_missing_and_verify "${SAXON_URL}" "${SAXON_JAR}" "${SAXON_SHA256}"
download_if_missing_and_verify "${XMLRESOLVER_URL}" "${XMLRESOLVER_JAR}" "${XMLRESOLVER_SHA256}"
download_if_missing_and_verify "${XMLRESOLVER_DATA_URL}" "${XMLRESOLVER_DATA_JAR}" "${XMLRESOLVER_DATA_SHA256}"

FNFE_ROOT="${RULES_DIR}/${FNFE_ARCHIVE_NAME}/Factur-X_1.09/EN16931"
XSD="${FNFE_ROOT}/1xsd/Factur-X_EN16931.xsd"
PROFILE_XSLT="${FNFE_ROOT}/2xslt/FACTUR-X_EN16931.xslt"
PROFILE_CODEDB="${FNFE_ROOT}/2xslt/FACTUR-X_EN16931_codedb.xml"
FRANCE_XSLT="${FNFE_ROOT}/2xslt/BR-FR-Flux2-Schematron-CII.xslt"

# L'image one-shot prépare le bundle hors de toute donnée puis le monte en lecture seule dans le
# sandbox réseau-isolé. Ne jamais tenter de réécrire ce corpus à chaque facture s'il est présent.
if [[ ! -f "${XSD}" || ! -f "${PROFILE_XSLT}" || ! -f "${FRANCE_XSLT}" ]]; then
  unzip -oq "${FNFE_ZIP}" -d "${RULES_DIR}"
fi

verify_sha256 "${XSD}" "${XSD_SHA256}"
verify_sha256 "${PROFILE_XSLT}" "${PROFILE_XSLT_SHA256}"
verify_sha256 "${PROFILE_CODEDB}" "${PROFILE_CODEDB_SHA256}"
verify_sha256 "${FRANCE_XSLT}" "${FRANCE_XSLT_SHA256}"

if [[ "${FNFE_PREPARE_ONLY:-false}" == 'true' ]]; then
  printf 'Bundle FNFE-MPE %s préparé et certifié hors de tout document.\n' "${FNFE_VERSION}"
  exit 0
fi

# --nonet et -dtd:off/-ext:off garantissent qu'une certification ne dépend pas d'une ressource
# mutable ou d'une résolution externe silencieuse.
xmllint --nonet --noout --schema "${XSD}" "${XML_PATH}"

SAXON_CLASSPATH="${SAXON_JAR}:${XMLRESOLVER_JAR}:${XMLRESOLVER_DATA_JAR}"
PROFILE_REPORT="${REPORT_DIR}/facturx-en16931.svrl.xml"
FRANCE_REPORT="${REPORT_DIR}/br-fr-flux2-cii.svrl.xml"

java -cp "${SAXON_CLASSPATH}" net.sf.saxon.Transform \
  -dtd:off -ext:off -s:"${XML_PATH}" -xsl:"${PROFILE_XSLT}" -o:"${PROFILE_REPORT}"
node .github/scripts/assert-fnfe-svrl.mjs "${PROFILE_REPORT}" \
  "Factur-X EN16931 / FNFE ${FNFE_VERSION}"

java -cp "${SAXON_CLASSPATH}" net.sf.saxon.Transform \
  -dtd:off -ext:off -s:"${XML_PATH}" -xsl:"${FRANCE_XSLT}" -o:"${FRANCE_REPORT}"
node .github/scripts/assert-fnfe-svrl.mjs "${FRANCE_REPORT}" \
  "BR-FR Flux 2 CII strict / FNFE ${FNFE_VERSION}"

# Test sentinelle propre au corpus 1.4 : un GlobalID SIREN à huit chiffres reste valide au XSD,
# mais doit impérativement déclencher BR-FR-32-GLOBALID. Il prouve que le gate courant est exercé,
# au lieu d'accepter silencieusement la sortie d'un ancien moteur embarqué.
if [[ "${FNFE_RUN_SENTINEL:-true}" == 'true' ]]; then
  NEGATIVE_XML="${REPORT_DIR}/invalid-br-fr-32-globalid.xml"
  NEGATIVE_REPORT="${REPORT_DIR}/invalid-br-fr-32-globalid.svrl.xml"
  node .github/scripts/make-fnfe-negative-fixture.mjs "${XML_PATH}" "${NEGATIVE_XML}"
  xmllint --nonet --noout --schema "${XSD}" "${NEGATIVE_XML}"
  java -cp "${SAXON_CLASSPATH}" net.sf.saxon.Transform \
    -dtd:off -ext:off -s:"${NEGATIVE_XML}" -xsl:"${FRANCE_XSLT}" -o:"${NEGATIVE_REPORT}"
  node .github/scripts/assert-fnfe-svrl.mjs "${NEGATIVE_REPORT}" \
    "Sentinelle BR-FR-32 / FNFE ${FNFE_VERSION}" BR-FR-32-GLOBALID
fi

printf 'Factur-X EN16931 certifié contre FNFE-MPE %s (XSD + profil + BR-FR strict).\n' "${FNFE_VERSION}"
