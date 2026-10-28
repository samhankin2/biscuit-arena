"""Provision the Arnott's Biscuit Arena VM on Oracle Cloud, entirely through the API.

What it does:
  1. finds a public subnet in an existing VCN (or reports what it found),
  2. opens TCP 80/443 in the security lists attached to that subnet,
  3. launches an always-free instance whose cloud-init bootstrap installs
     Node 24, Caddy and the app (deploy/bootstrap.sh),
  4. waits for RUNNING and prints the public IP and https hostname.

Usage:  python deploy/oci_provision.py            # dry run
        ARENA_LAUNCH=1 python deploy/oci_provision.py

Auth:  ~/.oci/config  (OCI API key)
"""

import base64
import json
import os
import pathlib
import time

import oci
from oci.core.models import (
    CreateVnicDetails,
    InstanceSourceViaImageDetails,
    LaunchInstanceDetails,
    LaunchInstanceShapeConfigDetails,
)

HOME = pathlib.Path.home()
OCI_DIR = HOME / ".oci"
HERE = pathlib.Path(__file__).parent
DISPLAY_NAME = "biscuit-arena"

# (shape, ocpus, memory_gb, architecture)
SHAPE_PREFERENCE = [
    ("VM.Standard.A1.Flex", 2, 12, "aarch64"),   # Ampere A1, always-free tier
    ("VM.Standard.E2.1.Micro", None, None, "x86_64"),  # x86, always-free tier
]


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def load_config():
    cfg = oci.config.from_file(OCI_DIR / "config")
    return cfg, oci.core.ComputeClient(cfg), oci.core.VirtualNetworkClient(cfg)


def list_images(compute, compartment_id):
    """All platform images in the compartment, across pages."""
    images, page = [], None
    while True:
        response = (
            compute.list_images(compartment_id=compartment_id, page=page)
            if page
            else compute.list_images(compartment_id=compartment_id)
        )
        images.extend(response.data)
        page = getattr(response, "next_page", None)
        if not page:
            break
    return images


def pick_image(images, arch):
    """Newest Ubuntu 24.04 image for the given architecture."""
    candidates = []
    for image in images:
        name = (image.display_name or "").lower()
        if "ubuntu" not in name or "24.04" not in name:
            continue
        is_arm = "aarch64" in name
        if (arch == "aarch64") != is_arm:
            continue
        candidates.append(image)
    if not candidates:
        return None
    candidates.sort(key=lambda i: i.display_name, reverse=True)
    return candidates[0]


def find_public_subnet(vn, compartment_id):
    """A subnet whose route table has an internet gateway and allows public IPs."""
    candidates = []
    for vcn in vn.list_vcns(compartment_id=compartment_id).data:
        for subnet in vn.list_subnets(compartment_id=compartment_id, vcn_id=vcn.id).data:
            route_table = vn.get_route_table(subnet.route_table_id).data
            has_igw = any(
                "internetgateway" in str(getattr(rule.network_entity_id, "id", rule.network_entity_id)).lower()
                for rule in route_table.route_rules
            )
            if has_igw and not subnet.prohibit_public_ip_on_vnic:
                candidates.append((vcn, subnet))
    if not candidates:
        raise SystemExit("no public subnet with an internet gateway route found")
    vcn, subnet = candidates[0]
    log(f"subnet {subnet.display_name} ({subnet.id}) in VCN {vcn.display_name}")
    return vcn, subnet


def open_ports(vn, security_list_ids, ports=(80, 443)):
    """Add ingress rules for the given TCP ports (idempotent)."""
    for security_list_id in security_list_ids:
        security_list = vn.get_security_list(security_list_id).data
        rules = list(security_list.ingress_security_rules or [])

        def covered(port):
            return any(
                r.tcp_options and r.tcp_options.destination_port_range
                and r.tcp_options.destination_port_range.min <= port <= r.tcp_options.destination_port_range.max
                for r in rules
            )

        changed = False
        for port in ports:
            if covered(port):
                continue
            log(f"opening TCP {port} in {security_list.display_name}")
            rules.append(
                oci.core.models.IngressSecurityRule(
                    source="0.0.0.0/0",
                    protocol="6",
                    tcp_options=oci.core.models.TcpOptions(
                        destination_port_range=oci.core.models.PortRange(min=port, max=port)
                    ),
                )
            )
            changed = True

        if changed:
            vn.update_security_list(
                security_list_id,
                oci.core.models.UpdateSecurityListDetails(ingress_security_rules=rules),
            )


def build_user_data():
    """cloud-init user_data must be Base64 encoded."""
    script = (HERE / "bootstrap.sh").read_text(encoding="utf-8")
    script = script.replace("\r\n", "\n").replace("\r", "\n")
    if not script.startswith("#!"):
        raise SystemExit("bootstrap.sh must start with a shebang")
    return base64.b64encode(script.encode("utf-8")).decode("ascii")


def main():
    cfg, compute, vn = load_config()
    compartment_id = cfg["tenancy"]
    identity = oci.identity.IdentityClient(cfg)
    log(f"region={cfg['region']} compartment={compartment_id}")

    existing = [
        i for i in compute.list_instances(compartment_id=compartment_id).data
        if i.display_name == DISPLAY_NAME and i.lifecycle_state not in ("TERMINATING", "TERMINATED")
    ]
    if existing:
        instance = existing[0]
        log(f"instance already exists: {instance.id} ({instance.lifecycle_state})")
    else:
        vcn, subnet = find_public_subnet(vn, compartment_id)
        open_ports(vn, subnet.security_list_ids)

        availability_domains = identity.list_availability_domains(compartment_id=compartment_id).data
        if not availability_domains:
            raise SystemExit("no availability domains available")
        ad_name = availability_domains[0].name
        log(f"availability domain: {ad_name}")

        images = list_images(compute, compartment_id)
        user_data = build_user_data()
        ssh_key = (OCI_DIR / "deploy_key.pub").read_text().strip()

        instance = None
        for shape, ocpus, memory_gb, arch in SHAPE_PREFERENCE:
            image = pick_image(images, arch)
            if image is None:
                log(f"no Ubuntu 24.04 {arch} image available, skipping {shape}")
                continue
            log(f"launching {shape} from {image.display_name}")
            details = LaunchInstanceDetails(
                availability_domain=ad_name,
                compartment_id=compartment_id,
                display_name=DISPLAY_NAME,
                shape=shape,
                shape_config=(
                    LaunchInstanceShapeConfigDetails(ocpus=ocpus, memory_in_gbs=memory_gb)
                    if ocpus
                    else None
                ),
                source_details=InstanceSourceViaImageDetails(
                    source_type="image",
                    image_id=image.id,
                    boot_volume_size_in_gbs=50,
                ),
                create_vnic_details=CreateVnicDetails(
                    subnet_id=subnet.id,
                    assign_public_ip=True,
                ),
                metadata={"ssh_authorized_keys": ssh_key, "user_data": user_data},
            )
            wire = compute.base_client.sanitize_for_serialization(details)
            preview = dict(wire)
            preview["metadata"] = dict(wire["metadata"])
            preview["metadata"]["user_data"] = f"<base64, {len(user_data)} chars>"
            log(json.dumps(preview))
            if os.environ.get("ARENA_LAUNCH") != "1":
                log("dry run only — set ARENA_LAUNCH=1 to launch")
                return

            try:
                instance = compute.launch_instance(
                    details, retry_strategy=oci.retry.NoneRetryStrategy()
                ).data
                log(f"launch accepted: {instance.id}")
                break
            except oci.exceptions.ServiceError as exc:
                log(f"launch failed: HTTP {exc.status} {exc.code} — {exc.message[:200]}")
                if "capacity" in str(exc).lower():
                    continue
                raise

        if instance is None:
            raise SystemExit("could not launch an instance on any free-tier shape")

    if instance.lifecycle_state != "RUNNING":
        instance = oci.wait_until(
            compute,
            compute.get_instance(instance.id),
            property="lifecycle_state",
            state="RUNNING",
            max_interval_seconds=15,
            max_wait_seconds=1800,
        ).data

    public_ip = None
    for attachment in compute.list_vnic_attachments(
        compartment_id=compartment_id, instance_id=instance.id
    ).data:
        vnic = vn.get_vnic(attachment.vnic_id).data
        if vnic.public_ip:
            public_ip = vnic.public_ip
            break

    hostname = f"arena.{public_ip}.sslip.io"
    result = {
        "instance_id": instance.id,
        "shape": instance.shape,
        "compartment_id": compartment_id,
        "public_ip": public_ip,
        "hostname": hostname,
        "api_base": f"https://{hostname}",
    }
    (HERE / "provision-result.json").write_text(json.dumps(result, indent=2))
    log(f"public ip: {public_ip}")
    log(f"hostname:  {hostname}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
